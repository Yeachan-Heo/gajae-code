import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { kNoAuth, ModelRegistry } from "../../../coding-agent/src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../../coding-agent/src/config/settings";
import { AuthStorage } from "../../../coding-agent/src/session/auth-storage";
import { streamBedrock } from "../../src/providers/amazon-bedrock";
import { hasResolvableAwsProfileSource } from "../../src/providers/aws-credential-config";
import { clearAwsCredentialCache, resolveAwsCredentials } from "../../src/providers/aws-credentials";
import { getEnvApiKey } from "../../src/stream";
import type { Context, Model, Tool } from "../../src/types";

const scenario = process.argv[2];
const root = process.argv[3];

if (!scenario || !root) throw new Error("scenario and root are required");

const credentialsPath = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(root, "credentials");
const configPath = process.env.AWS_CONFIG_FILE || path.join(root, "config");
const model: Model<"bedrock-converse-stream"> = {
	id: "anthropic.test-model",
	name: "test",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};
const forcedTool: Tool = {
	name: "read",
	description: "Read",
	parameters: { type: "object", properties: {}, additionalProperties: false },
};
const context: Context = { messages: [{ role: "user", content: "ping", timestamp: 0 }], tools: [forcedTool] };

type CapturedRequest = {
	authorization?: string;
	bodySha256: string;
	bodyWithoutToolChoiceSha256: string;
	contentSha256?: string;
	headers: string[];
	body: Record<string, unknown>;
};

async function sha256(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function withoutToolChoice(body: Record<string, unknown>): Record<string, unknown> {
	const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
	const toolConfig = copy.toolConfig;
	if (toolConfig && typeof toolConfig === "object") delete (toolConfig as Record<string, unknown>).toolChoice;
	return copy;
}

function output(value: object): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function captureTransport(
	forced: boolean,
	status = forced ? 400 : 403,
): Promise<{ requests: CapturedRequest[]; resultError?: string }> {
	const originalFetch = globalThis.fetch;
	const requests: CapturedRequest[] = [];
	const fetchStub = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (
				requestUrl !== "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.test-model/converse-stream"
			) {
				throw new Error("Unexpected network URL.");
			}
			const headers = new Headers(init?.headers);
			const bodyText = new TextDecoder().decode(init?.body as Uint8Array);
			const body = JSON.parse(bodyText) as Record<string, unknown>;
			requests.push({
				authorization: headers.get("authorization") ?? undefined,
				bodySha256: await sha256(bodyText),
				bodyWithoutToolChoiceSha256: await sha256(JSON.stringify(withoutToolChoice(body))),
				contentSha256: headers.get("x-amz-content-sha256") ?? undefined,
				headers: [...headers.keys()].sort(),
				body,
			});

			return new Response("validationException: toolChoice is not supported", { status });
		},
		{ preconnect: originalFetch.preconnect },
	);
	globalThis.fetch = fetchStub;
	try {
		clearAwsCredentialCache();
		const stream = streamBedrock(model, context, {
			toolChoice: forced ? { type: "tool", name: forcedTool.name } : undefined,
			requestMaxRetries: 0,
		});
		const result = await stream.result();
		return { requests, resultError: result.errorMessage };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function main(): Promise<void> {
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(credentialsPath, "");
	await fs.writeFile(configPath, "");

	switch (scenario) {
		case "profile-static":
		case "profile-path-spaces": {
			await fs.writeFile(credentialsPath, "[default]\naws_access_key_id = dummy\naws_secret_access_key = dummy\n");
			const resolved = await resolveAwsCredentials({ region: "us-east-1" });
			output({
				available: getEnvApiKey("amazon-bedrock") === "<authenticated>",
				profile: hasResolvableAwsProfileSource(),
				resolved: Boolean(resolved.accessKeyId && resolved.secretAccessKey),
			});
			return;
		}
		case "profile-named-static": {
			await fs.writeFile(credentialsPath, "[team]\naws_access_key_id = dummy\naws_secret_access_key = dummy\n");
			const resolved = await resolveAwsCredentials({ region: "us-east-1" });
			output({
				available: getEnvApiKey("amazon-bedrock") === "<authenticated>",
				profile: hasResolvableAwsProfileSource(),
				resolved: Boolean(resolved.accessKeyId && resolved.secretAccessKey),
			});
			return;
		}

		case "profile-home-static": {
			const home = process.env.HOME;
			if (!home) throw new Error("HOME is required for the default profile scenario");
			const defaultCredentialsPath = path.join(home, ".aws", "credentials");
			await fs.mkdir(path.dirname(defaultCredentialsPath), { recursive: true });
			await fs.writeFile(
				defaultCredentialsPath,
				"[default]\naws_access_key_id = dummy\naws_secret_access_key = dummy\n",
			);
			output({
				available: getEnvApiKey("amazon-bedrock") === "<authenticated>",
				profile: hasResolvableAwsProfileSource(),
			});
			return;
		}
		case "profile-sso": {
			await fs.writeFile(
				configPath,
				"[profile team]\r\nsso_account_id = account\r\nsso_role_name = role\r\nsso_session = corp\r\n[sso-session corp]\r\nsso_start_url = https://example.test/start\r\nsso_region = us-east-1\r\n",
			);
			output({
				available: getEnvApiKey("amazon-bedrock") === "<authenticated>",
				profile: hasResolvableAwsProfileSource(),
			});
			return;
		}
		case "profile-process": {
			await fs.writeFile(configPath, "[default]\ncredential_process = false\n");
			output({
				available: getEnvApiKey("amazon-bedrock") === "<authenticated>",
				profile: hasResolvableAwsProfileSource(),
			});
			return;
		}
		case "static-env": {
			const resolved = await resolveAwsCredentials({ region: "us-east-1" });
			output({
				available: getEnvApiKey("amazon-bedrock") === "<authenticated>",
				resolved: Boolean(resolved.accessKeyId && resolved.secretAccessKey),
				sessionToken: Boolean(resolved.sessionToken),
			});
			return;
		}
		case "no-credentials": {
			let resolved = false;
			try {
				await resolveAwsCredentials({ region: "us-east-1" });
				resolved = true;
			} catch (error) {
				if (!(error instanceof Error) || !error.message.startsWith("Unable to resolve AWS credentials."))
					throw error;
			}
			const transport = await captureTransport(false);
			output({
				available: getEnvApiKey("amazon-bedrock") === "<authenticated>",
				resolved,
				transportRequests: transport.requests.length,
			});
			return;
		}

		case "profile-negative-matrix": {
			await fs.writeFile(credentialsPath, "[incomplete-static]\naws_access_key_id = dummy\n");
			await fs.writeFile(
				configPath,
				"[profile region-only]\nregion = us-east-1\n[profile incomplete-sso]\nsso_account_id = account\nsso_role_name = role\n[profile unsupported]\nrole_arn = arn:aws:iam::1:role/test\nsource_profile = default\n",
			);
			const regionOnly = hasResolvableAwsProfileSource({ profile: "region-only" }, 1);
			const incompleteStatic = hasResolvableAwsProfileSource({ profile: "incomplete-static" }, 2);
			const incompleteSso = hasResolvableAwsProfileSource({ profile: "incomplete-sso" }, 3);
			const unsupported = hasResolvableAwsProfileSource({ profile: "unsupported" }, 4);
			const missing = hasResolvableAwsProfileSource({ profile: "missing" }, 5);
			await fs.writeFile(credentialsPath, "not-an-ini-section\naws_access_key_id = dummy\n");
			await fs.writeFile(configPath, "[profile malformed\ncredential_process = false\n");
			const malformed = hasResolvableAwsProfileSource({ profile: "malformed" }, 6);
			output({ regionOnly, incompleteStatic, incompleteSso, unsupported, missing, malformed });
			return;
		}
		case "registry-static":
		case "registry-empty":
		case "registry-dotenv":
		case "registry-none": {
			if (scenario === "registry-static") {
				await fs.writeFile(
					credentialsPath,
					"[default]\naws_access_key_id = dummy\naws_secret_access_key = dummy\n",
				);
			}
			const modelsPath = path.join(root, "models.json");
			const providers =
				scenario === "registry-none"
					? {
							"amazon-bedrock": {
								baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
								api: "bedrock-converse-stream",
								auth: "none",
								models: [{ id: "anthropic.no-auth-model" }],
							},
						}
					: {};
			await fs.writeFile(modelsPath, JSON.stringify({ providers }));
			resetSettingsForTest();
			const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
			try {
				await Settings.init({ inMemory: true, cwd: root, agentDir: path.join(root, "agent") });
				const registry = new ModelRegistry(authStorage, modelsPath);
				const available = registry.getAvailable();
				output({
					bedrock: available.some(candidate => candidate.provider === "amazon-bedrock"),
					openai: available.some(candidate => candidate.provider === "openai"),
					noAuth:
						scenario === "registry-none"
							? available.some(
									candidate =>
										candidate.provider === "amazon-bedrock" && candidate.id === "anthropic.no-auth-model",
								)
							: false,
					key: scenario === "registry-none" ? await registry.getApiKeyForProvider("amazon-bedrock") : undefined,
					noAuthSentinel: kNoAuth,
				});
			} finally {
				authStorage.close();
				resetSettingsForTest();
			}
			return;
		}
		case "negative": {
			await fs.writeFile(credentialsPath, "[default]\naws_access_key_id = dummy\n");
			await fs.writeFile(configPath, "[profile incomplete-sso]\nsso_account_id = account\nsso_role_name = role\n");
			output({
				available: getEnvApiKey("amazon-bedrock") === "<authenticated>",
				profile: hasResolvableAwsProfileSource(),
			});
			return;
		}
		case "dotenv": {
			let resolved = false;
			try {
				await resolveAwsCredentials({ region: "us-east-1" });
				resolved = true;
			} catch (error) {
				if (
					!(error instanceof Error) ||
					error.message !==
						"Unable to resolve AWS credentials. Set AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY, or configure profile 'default' in ~/.aws/credentials (or ~/.aws/config for SSO)."
				) {
					throw error;
				}
			}
			const transport = await captureTransport(false);
			output({
				available: getEnvApiKey("amazon-bedrock") === "<authenticated>",
				openai: Boolean(getEnvApiKey("openai")),
				resolved,
				transportRequests: transport.requests.length,
			});
			return;
		}
		case "dotenv-imds-disabled": {
			const originalFetch = globalThis.fetch;
			let imdsFetches = 0;
			globalThis.fetch = Object.assign(
				async () => {
					imdsFetches++;
					throw new Error("Unexpected IMDS fetch.");
				},
				{ preconnect: originalFetch.preconnect },
			);
			let resolved = false;
			try {
				await resolveAwsCredentials({ region: "us-east-1" });
				resolved = true;
			} catch (error) {
				if (!(error instanceof Error) || !error.message.startsWith("Unable to resolve AWS credentials."))
					throw error;
			} finally {
				globalThis.fetch = originalFetch;
			}
			output({ imdsFetches, resolved });
			return;
		}
		case "cache": {
			const availableProfile = "[default]\naws_access_key_id = dummy\naws_secret_access_key = dummy\n";
			const unavailableProfile = "[default]\naws_access_key_id = dumme\naws_secret_access_kez = dummy\n";
			await fs.writeFile(credentialsPath, availableProfile);
			let scans = 0;
			const onScan = () => {
				scans++;
				if (scans === 2) {
					const stat = fsSync.statSync(credentialsPath);
					fsSync.writeFileSync(credentialsPath, unavailableProfile);
					fsSync.utimesSync(credentialsPath, stat.atime, stat.mtime);
				}
			};
			const initial = hasResolvableAwsProfileSource({ onScan }, 1);
			const cachedWithinAge = hasResolvableAwsProfileSource({ onScan }, 2);
			const correctedAfterMaxAge = hasResolvableAwsProfileSource({ onScan }, 1_001);
			output({ initial, cachedWithinAge, correctedAfterMaxAge, scans });
			return;
		}
		case "cache-transitions": {
			await fs.writeFile(
				credentialsPath,
				"[default]\naws_access_key_id = dummy\naws_secret_access_key = dummy\n[other]\naws_access_key_id = dummy\n",
			);
			const initial = hasResolvableAwsProfileSource({ profile: "default" }, 1);
			await fs.rm(credentialsPath);
			const deleted = hasResolvableAwsProfileSource({ profile: "default" }, 2);
			await fs.writeFile(credentialsPath, "[default]\naws_access_key_id = dummy\naws_secret_access_key = dummy\n");
			const recreated = hasResolvableAwsProfileSource({ profile: "default" }, 3);
			const profileChanged = hasResolvableAwsProfileSource({ profile: "other" }, 4);
			output({ initial, profileChanged, deleted, recreated });
			return;
		}
		case "bearer":
		case "bearer-forced":
		case "bearer-unauthorized":
		case "sigv4": {
			const transport = await captureTransport(
				scenario === "bearer-forced",
				scenario === "bearer-unauthorized" ? 401 : undefined,
			);
			output({
				requests: transport.requests.map(request => ({
					bearer: request.authorization?.startsWith("Bearer ") ?? false,
					sigv4: request.authorization?.startsWith("AWS4-HMAC-SHA256") ?? false,
					bodySha256: request.bodySha256,
					bodyWithoutToolChoiceSha256: request.bodyWithoutToolChoiceSha256,
					contentSha256: request.contentSha256,
					headers: request.headers,
					hasToolChoice: Boolean((request.body.toolConfig as { toolChoice?: unknown } | undefined)?.toolChoice),
				})),
				authorizationChanged:
					transport.requests.length === 2 &&
					transport.requests[0]?.authorization !== transport.requests[1]?.authorization,
				resultError: transport.resultError,
			});
			return;
		}
		case "malformed": {
			const transport = await captureTransport(false);
			output({
				available: getEnvApiKey("amazon-bedrock") === "<authenticated>",
				requests: transport.requests.length,
				resultError: transport.resultError ?? "",
			});
			return;
		}
		default:
			throw new Error(`unknown scenario: ${scenario}`);
	}
}

await main();
