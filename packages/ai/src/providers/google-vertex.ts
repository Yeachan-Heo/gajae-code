import { $credentialEnv, $pickCredentialEnv } from "@gajae-code/utils";
import type { Context, Model, StreamFunction } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { getVertexAccessToken } from "./google-auth";
import {
	buildGoogleGenerateContentParams,
	type GoogleGenAIRequestPlan,
	type GoogleSharedStreamOptions,
	streamGoogleGenAI,
} from "./google-shared";

export interface GoogleVertexOptions extends GoogleSharedStreamOptions {
	project?: string;
	location?: string;
}

const API_VERSION = "v1";

export const streamGoogleVertex: StreamFunction<"google-vertex"> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream =>
	streamGoogleGenAI({
		model,
		options,
		api: "google-vertex",
		retainTextSignature: true,
		prepare: async (): Promise<GoogleGenAIRequestPlan> => {
			const apiKey = resolveApiKey(options);
			const params = buildGoogleGenerateContentParams(model, context, options ?? {});
			const baseHeaders: Record<string, string> = {
				...(model.headers ?? {}),
				...(options?.headers ?? {}),
			};

			if (apiKey) {
				const url = `https://aiplatform.googleapis.com/${API_VERSION}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`;
				return {
					params,
					url,
					headers: { ...baseHeaders, "x-goog-api-key": apiKey },
					fetch: options?.fetch,
				};
			}

			const project = resolveProject(options);
			const location = resolveLocation(options);
			const accessToken = await getVertexAccessToken({ signal: options?.signal, fetch: options?.fetch });
			const host = resolveEndpointHost(location);
			const url = `https://${host}/${API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`;
			return {
				params,
				url,
				headers: { ...baseHeaders, Authorization: `Bearer ${accessToken}` },
				fetch: options?.fetch,
			};
		},
	});

/** Test seam: the Vertex API key as resolved from options plus trusted env. */
export function resolveVertexApiKeyForTest(options?: GoogleVertexOptions): string | undefined {
	return resolveApiKey(options);
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	// options.apiKey may contain sentinel values like "<authenticated>" or "N/A"
	// leaked from the agent loop — only use it if it looks like a real API key.
	const optKey = options?.apiKey;
	const realKey = optKey && !optKey.startsWith("<") && optKey !== "N/A" ? optKey : undefined;
	return realKey || $credentialEnv("GOOGLE_CLOUD_API_KEY");
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project = options?.project || $pickCredentialEnv("GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT");
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveEndpointHost(location: string): string {
	return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}
/**
 * Vertex location, from trusted environment sources only and constrained to a
 * region label.
 *
 * The location is interpolated into the request **host**
 * (`${location}-aiplatform.googleapis.com`) as well as the path, and the request
 * carries `Authorization: Bearer <accessToken>`. A value containing `/`
 * terminates the authority component, so `evil.example.com/` resolves to origin
 * `https://evil.example.com` and the Google access token leaves Google entirely.
 * `$env` merges the caller's `cwd/.env`, so this was reachable from repository
 * content.
 *
 * Both halves are needed: trusted resolution keeps a repository from setting it,
 * and the shape check keeps any source from turning a region into an authority.
 */
const VERTEX_LOCATION_RE = /^[a-z0-9-]+$/;

function assertVertexLocation(location: string): string {
	if (!VERTEX_LOCATION_RE.test(location)) {
		throw new Error(
			`Invalid Vertex AI location ${JSON.stringify(location)}. Expected a region label such as "us-central1" or "global".`,
		);
	}
	return location;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || $credentialEnv("GOOGLE_CLOUD_LOCATION");
	if (!location) {
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	return assertVertexLocation(location);
}

/** Test seam: the Vertex location as resolved from options plus trusted env. */
export function resolveVertexLocationForTest(options?: GoogleVertexOptions): string {
	return resolveLocation(options);
}
