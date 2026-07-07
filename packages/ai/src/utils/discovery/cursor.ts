import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import * as z from "zod/v4";
import { getBundledModels } from "../../models";
import { CURSOR_CLIENT_VERSION } from "../../providers/cursor/client-version";
import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from "../../providers/cursor/gen/agent_pb";
import type { Model } from "../../types";

const CURSOR_DEFAULT_BASE_URL = "https://api2.cursor.sh";
const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

const OptionalDisplayNameSchema = z.string().optional().catch(undefined);
const CursorAliasesSchema = z
	.array(z.unknown())
	.optional()
	.catch([])
	.transform(aliases => (aliases ?? []).filter((alias: unknown): alias is string => typeof alias === "string"));

const CursorModelDetailsSchema = z.object({
	modelId: z.string(),
	displayName: OptionalDisplayNameSchema,
	displayNameShort: OptionalDisplayNameSchema,
	displayModelId: OptionalDisplayNameSchema,
	aliases: CursorAliasesSchema,
	thinkingDetails: z.unknown().optional(),
});

const CursorDecodedResponseSchema = z.object({
	models: z.array(z.unknown()).optional().catch([]),
});

type CursorModelDetailsValue = z.infer<typeof CursorModelDetailsSchema>;

/**
 * Options for fetching dynamic Cursor models from `GetUsableModels`.
 */
export interface CursorModelDiscoveryOptions {
	/** Cursor access token used for bearer authentication. */
	apiKey: string;
	/** Optional Cursor API base URL override. */
	baseUrl?: string;
	/** Optional client version override sent as `x-cursor-client-version`. */
	clientVersion?: string;
	/** Optional request timeout in milliseconds. */
	timeoutMs?: number;
	/** Optional list of custom Cursor model ids to include in request context. */
	customModelIds?: string[];
}

/**
 * Fetches Cursor models through `GetUsableModels` and normalizes them into canonical model entries.
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchCursorUsableModels(
	options: CursorModelDiscoveryOptions,
): Promise<Model<"cursor-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	try {
		const requestPayload = create(GetUsableModelsRequestSchema, {
			customModelIds: normalizeCustomModelIds(options.customModelIds),
		});
		const body = toBinary(GetUsableModelsRequestSchema, requestPayload);
		const baseUrl = (options.baseUrl ?? CURSOR_DEFAULT_BASE_URL).replace(/\/+$/, "");

		const responseBuffer = await fetchViaHttp2(baseUrl, body, options, timeoutMs);

		if (!responseBuffer) {
			return null;
		}
		const decoded = decodeGetUsableModelsResponse(responseBuffer);
		const parsedDecoded = CursorDecodedResponseSchema.safeParse(decoded);
		if (!parsedDecoded.success) {
			return null;
		}

		const references = createCursorReferenceMap();
		return normalizeCursorModels(parsedDecoded.data.models, options.baseUrl, references);
	} catch {
		return null;
	}
}

function buildRequestHeaders(options: CursorModelDiscoveryOptions): Record<string, string> {
	return {
		"content-type": "application/proto",
		te: "trailers",
		authorization: `Bearer ${options.apiKey}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": options.clientVersion ?? CURSOR_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
	};
}

/** HTTP/2 transport required by Cursor API (HTTP/1.1 is rejected with 464). */
async function fetchViaHttp2(
	baseUrl: string,
	body: Uint8Array,
	options: CursorModelDiscoveryOptions,
	timeoutMs: number,
): Promise<Uint8Array | null> {
	const { promise, resolve } = Promise.withResolvers<Uint8Array | null>();
	const client = http2.connect(baseUrl);
	const timer = setTimeout(() => {
		client.destroy();
		resolve(null);
	}, timeoutMs);

	client.on("error", () => {
		clearTimeout(timer);
		resolve(null);
	});

	const req = client.request({
		":method": "POST",
		":path": CURSOR_GET_USABLE_MODELS_PATH,
		...buildRequestHeaders(options),
	});

	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		clearTimeout(timer);
		client.close();
		resolve(new Uint8Array(Buffer.concat(chunks)));
	});
	req.on("error", () => {
		clearTimeout(timer);
		client.close();
		resolve(null);
	});
	req.on("response", headers => {
		const status = Number(headers[":status"] ?? 0);
		if (status < 200 || status >= 300) {
			clearTimeout(timer);
			client.close();
			resolve(null);
		}
	});

	if (body.length > 0) {
		req.end(Buffer.from(body));
	} else {
		req.end();
	}

	return promise;
}

function normalizeCustomModelIds(customModelIds: readonly string[] | undefined): string[] {
	if (!customModelIds) {
		return [];
	}
	const normalized = new Set<string>();
	for (const value of customModelIds) {
		if (typeof value !== "string") {
			continue;
		}
		const trimmed = value.trim();
		if (!trimmed) {
			continue;
		}
		normalized.add(trimmed);
	}
	return [...normalized];
}

function createCursorReferenceMap(): Map<string, Model<"cursor-agent">> {
	const references = new Map<string, Model<"cursor-agent">>();
	for (const model of getBundledModels("cursor") as Model<"cursor-agent">[]) {
		references.set(model.id, model);
	}
	return references;
}

function decodeGetUsableModelsResponse(payload: Uint8Array) {
	if (payload.length === 0) {
		return null;
	}

	const framedBody = decodeConnectUnaryBody(payload);
	if (framedBody) {
		try {
			return fromBinary(GetUsableModelsResponseSchema, framedBody);
		} catch {
			return null;
		}
	}

	try {
		return fromBinary(GetUsableModelsResponseSchema, payload);
	} catch {
		return null;
	}
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
	if (payload.length < 5) {
		return null;
	}

	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset];
		const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
		const messageLength = view.getUint32(1, false);
		const frameEnd = offset + 5 + messageLength;
		if (frameEnd > payload.length) {
			return null;
		}
		const compressionFlagSet = (flags & 0b0000_0001) !== 0;
		if (compressionFlagSet) {
			return null;
		}
		const endStreamFlagSet = (flags & 0b0000_0010) !== 0;
		if (!endStreamFlagSet) {
			return payload.subarray(offset + 5, frameEnd);
		}

		offset = frameEnd;
	}

	return null;
}

function normalizeCursorModels(
	models: readonly unknown[] | undefined,
	baseUrlOverride: string | undefined,
	references: Map<string, Model<"cursor-agent">>,
): Model<"cursor-agent">[] {
	if (!models || models.length === 0) {
		return [];
	}

	const byId = new Map<string, Model<"cursor-agent">>();
	for (const model of models) {
		const normalized = normalizeCursorModel(model, baseUrlOverride, references);
		if (!normalized) {
			continue;
		}
		byId.set(normalized.id, normalized);
	}

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeCursorModel(
	model: unknown,
	baseUrlOverride: string | undefined,
	references: Map<string, Model<"cursor-agent">>,
): Model<"cursor-agent"> | null {
	const parsedModel = CursorModelDetailsSchema.safeParse(model);
	if (!parsedModel.success) {
		return null;
	}

	const details = parsedModel.data;
	const id = details.modelId.trim();
	if (!id) {
		return null;
	}

	const name = pickModelDisplayName(details, id);
	const reference = references.get(id);
	const reasoning = Boolean(details.thinkingDetails) || reference?.reasoning === true;

	if (reference) {
		return {
			...reference,
			id,
			name,
			baseUrl: baseUrlOverride ?? reference.baseUrl,
			reasoning,
		};
	}
	return {
		id,
		name,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: baseUrlOverride ?? CURSOR_DEFAULT_BASE_URL,
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

function pickModelDisplayName(model: CursorModelDetailsValue, fallbackId: string): string {
	const candidates = [model.displayName, model.displayNameShort, model.displayModelId, ...model.aliases, fallbackId];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}
		const trimmed = candidate.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return fallbackId;
}
