import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const CHILD_FLAG = "--aws-region-credential-destination-probe";
const sourceRoot = path.resolve(import.meta.dir, "../src/providers");

type Scenario =
	| "aws-sso"
	| "aws-imds"
	| "bedrock-bearer"
	| "bedrock-sigv4"
	| "codewhisperer"
	| "kiro-discovered-stream"
	| "kiro-discovery"
	| "kiro-oidc-device"
	| "kiro-oidc-poll"
	| "kiro-oidc-refresh"
	| "kiro-static-stream"
	| "kiro-stream";

interface ProbeResult {
	fetches: Array<{
		url: string;
		host: string;
		authorization: "bearer" | "sigv4" | "none";
		ssoBearerToken: boolean;
		target: string | null;
	}>;
	error: string | null;
	redirect?: {
		initialRequests: number;
		targetRequests: Array<{
			authorization: string | null;
			securityToken: string | null;
			ssoBearerToken: string | null;
			target: string | null;
			body: string;
		}>;
	};
}

const tempDirs: string[] = [];

function model(api: "bedrock-converse-stream" | "kiro-codewhisperer-stream", baseUrl?: string) {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider: api === "bedrock-converse-stream" ? "amazon-bedrock" : "kiro",
		...(baseUrl ? { baseUrl } : {}),
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	};
}

const context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

async function consume(
	stream: AsyncIterable<{ type: string; error?: { errorMessage?: string } }>,
): Promise<string | null> {
	let error: string | null = null;
	for await (const event of stream) {
		if (event.type === "error") error = event.error?.errorMessage ?? "unknown stream error";
	}
	return error;
}

async function childMain(): Promise<void> {
	const scenario = process.argv[3] as Scenario;
	const explicitBaseUrl = process.argv[4] || undefined;
	const redirectProbe = process.argv[6] === "redirect";
	const forcedToolChoiceProbe = process.argv[7] === "forced-tool-choice";
	const probeRegion = process.argv[8] || "us-east-1";
	let statefulRegionRead = 0;
	const explicitRegion =
		process.argv[5] === "explicit-empty"
			? ""
			: process.argv[5] === "explicit-stateful"
				? ({
						toString: () => (statefulRegionRead++ === 0 ? "us-east-1" : "amazonaws.com@attacker.example/"),
					} as unknown as string)
				: undefined;
	const captures: ProbeResult["fetches"] = [];
	const nativeFetch = globalThis.fetch;
	let initialRequests = 0;
	const targetRequests: NonNullable<ProbeResult["redirect"]>["targetRequests"] = [];
	const targetServer = redirectProbe
		? Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					targetRequests.push({
						authorization: request.headers.get("authorization"),
						securityToken: request.headers.get("x-amz-security-token"),
						ssoBearerToken: request.headers.get("x-amz-sso_bearer_token"),
						target: request.headers.get("x-amz-target") ?? request.headers.get("amzn-x-amz-target"),
						body: await request.text(),
					});
					return scenario === "kiro-stream"
						? new Response('{"content":"ok"}', { status: 200 })
						: scenario === "kiro-oidc-poll"
							? new Response(
									JSON.stringify({
										accessToken: "redirect-target-access-token",
										refreshToken: "redirect-target-refresh-token",
										expiresIn: 3600,
										tokenType: "Bearer",
									}),
									{ status: 200, headers: { "Content-Type": "application/json" } },
								)
							: new Response(JSON.stringify({ models: [{ modelId: "test-model" }] }), { status: 200 });
				},
			})
		: undefined;
	const redirectServer = redirectProbe
		? Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					initialRequests++;
					return Response.redirect(`http://127.0.0.1:${targetServer?.port}/capture`, 307);
				},
			})
		: undefined;
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const parsed = new URL(url);
			const headers = new Headers(init?.headers);
			const authorization = headers.get("authorization") ?? "";
			captures.push({
				url,
				host: parsed.host,
				authorization: authorization.startsWith("Bearer ")
					? "bearer"
					: authorization.startsWith("AWS4-HMAC-SHA256 ")
						? "sigv4"
						: "none",
				ssoBearerToken: headers.has("x-amz-sso_bearer_token"),
				target: headers.get("x-amz-target") ?? headers.get("amzn-x-amz-target"),
			});
			if (forcedToolChoiceProbe && captures.length === 1) {
				return new Response("validationException: This model does not support forced toolChoice", { status: 400 });
			}
			if (!redirectServer && scenario === "aws-imds" && captures.length === 1) {
				return new Response("imds-test-token", { status: 200 });
			}
			if (!redirectServer && scenario === "aws-imds" && captures.length === 2) {
				return new Response("test-role\n", { status: 200 });
			}
			if (!redirectServer && scenario === "aws-imds" && captures.length === 3) {
				return new Response(
					JSON.stringify({
						AccessKeyId: "imds-access-key",
						SecretAccessKey: "imds-secret-key",
						Token: "imds-session-token",
						Expiration: "2099-01-01T00:00:00Z",
					}),
					{ status: 200 },
				);
			}
			if (scenario === "kiro-discovered-stream" && captures.length === 1) {
				return new Response(JSON.stringify({ models: [{ modelId: "test-model" }] }), { status: 200 });
			}
			if (scenario === "kiro-oidc-refresh" && captures.length === 1) {
				return new Response(
					JSON.stringify({
						clientId: "oidc-client-id",
						clientSecret: "oidc-client-secret",
						clientIdIssuedAt: Math.floor(Date.now() / 1000),
						clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
					}),
					{ status: 200 },
				);
			}
			if (redirectServer) {
				return nativeFetch(`http://127.0.0.1:${redirectServer.port}/start`, init);
			}
			if (scenario === "kiro-discovery") {
				return new Response(JSON.stringify({ models: [{ modelId: "test-model" }] }), { status: 200 });
			}
			if (scenario === "aws-sso") {
				return new Response(
					JSON.stringify({
						roleCredentials: {
							accessKeyId: "sso-access-key",
							secretAccessKey: "sso-secret-key",
							sessionToken: "sso-session-token",
							expiration: Date.now() + 60_000,
						},
					}),
					{ status: 200 },
				);
			}
			if (scenario === "kiro-oidc-device") {
				return new Response(
					JSON.stringify({
						deviceCode: "oidc-device-code",
						userCode: "ABCD-EFGH",
						verificationUri: "https://example.invalid/verify",
						interval: 1,
						expiresIn: 600,
					}),
					{ status: 200 },
				);
			}
			if (scenario === "kiro-stream") return new Response('{"content":"ok"}', { status: 200 });
			return new Response(new Uint8Array(), { status: 200 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	) as typeof globalThis.fetch;

	let error: string | null = null;
	if (scenario === "aws-sso") {
		const { resolveAwsCredentials } = await import(pathToFileURL(path.join(sourceRoot, "aws-credentials.ts")).href);
		try {
			await resolveAwsCredentials({ profile: "test-sso", region: "us-east-1" });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	} else if (scenario === "aws-imds") {
		const { resolveAwsCredentials } = await import(pathToFileURL(path.join(sourceRoot, "aws-credentials.ts")).href);
		try {
			await resolveAwsCredentials({ profile: "missing", region: "us-east-1" });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	} else if (scenario === "bedrock-bearer" || scenario === "bedrock-sigv4") {
		const { streamBedrock } = await import(pathToFileURL(path.join(sourceRoot, "amazon-bedrock.ts")).href);
		error = await consume(
			streamBedrock(
				model("bedrock-converse-stream") as never,
				(forcedToolChoiceProbe
					? {
							...context,
							tools: [
								{
									name: "read",
									description: "Read",
									parameters: { type: "object", properties: {}, additionalProperties: false },
								},
							],
						}
					: context) as never,
				{
					maxTokens: 32,
					region: explicitRegion,
					requestMaxRetries: 0,
					...(forcedToolChoiceProbe ? { toolChoice: "required" } : {}),
				} as never,
			),
		);
	} else if (scenario === "codewhisperer") {
		const { streamKiroCodeWhisperer } = await import(
			pathToFileURL(path.join(sourceRoot, "kiro-codewhisperer.ts")).href
		);
		error = await consume(
			streamKiroCodeWhisperer(
				model("kiro-codewhisperer-stream") as never,
				context as never,
				{ apiKey: "oauth-test-secret", region: explicitRegion } as never,
			),
		);
	} else if (scenario === "kiro-discovery") {
		const { fetchKiroApiModels } = await import(pathToFileURL(path.join(sourceRoot, "kiro-api-key.ts")).href);
		try {
			await fetchKiroApiModels("ksk_test-secret", explicitRegion);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	} else if (scenario === "kiro-discovered-stream" || scenario === "kiro-static-stream") {
		const { fetchKiroApiModels, kiroApiStaticModels, streamKiroApiKey } = await import(
			pathToFileURL(path.join(sourceRoot, "kiro-api-key.ts")).href
		);
		try {
			const catalog =
				scenario === "kiro-discovered-stream"
					? await fetchKiroApiModels("ksk_test-secret", "us-east-1")
					: kiroApiStaticModels();
			const selected = catalog.find((candidate: { id: string }) => candidate.id === "test-model") ?? catalog[0];
			error = await consume(
				streamKiroApiKey(selected as never, context as never, { apiKey: "ksk_test-secret" } as never),
			);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	} else if (scenario === "kiro-oidc-device") {
		const { startDeviceAuthorization } = await import(
			pathToFileURL(path.resolve(sourceRoot, "../utils/oauth/kiro.ts")).href
		);
		try {
			await startDeviceAuthorization(probeRegion, "https://view.awsapps.com/start", {
				clientId: "oidc-client-id",
				clientSecret: "oidc-client-secret",
				expiresAt: Date.now() + 60_000,
			});
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	} else if (scenario === "kiro-oidc-poll") {
		const { pollForToken } = await import(pathToFileURL(path.resolve(sourceRoot, "../utils/oauth/kiro.ts")).href);
		try {
			await pollForToken(
				probeRegion,
				{
					clientId: "oidc-client-id",
					clientSecret: "oidc-client-secret",
					expiresAt: Date.now() + 60_000,
				},
				"oidc-device-code",
				0,
				2,
			);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	} else if (scenario === "kiro-oidc-refresh") {
		const { refreshKiroToken, registerClient } = await import(
			pathToFileURL(path.resolve(sourceRoot, "../utils/oauth/kiro.ts")).href
		);
		try {
			await registerClient("us-east-1", "https://view.awsapps.com/start");
			await refreshKiroToken({
				access: "old-access-token",
				refresh: "oidc-refresh-token",
				expires: Date.now() - 1,
			});
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
	} else {
		const { streamKiroApiKey } = await import(pathToFileURL(path.join(sourceRoot, "kiro-api-key.ts")).href);
		error = await consume(
			streamKiroApiKey(
				model("kiro-codewhisperer-stream", explicitBaseUrl) as never,
				context as never,
				{ apiKey: "ksk_test-secret", region: explicitRegion } as never,
			),
		);
	}
	redirectServer?.stop(true);
	targetServer?.stop(true);
	process.stdout.write(
		`${JSON.stringify({
			fetches: captures,
			error,
			...(redirectProbe ? { redirect: { initialRequests, targetRequests } } : {}),
		} satisfies ProbeResult)}\n`,
	);
}

if (process.argv[2] === CHILD_FLAG) {
	await childMain();
} else {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function probe(
		scenario: Scenario,
		region: string,
		options: {
			source?: "environment" | "project" | "explicit";
			explicitBaseUrl?: string;
			explicitRegionKind?: "empty" | "stateful";
			redirect?: boolean;
			forcedToolChoice?: boolean;
		} = {},
	): Promise<ProbeResult> {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-aws-region-destination-"));
		tempDirs.push(cwd);
		if (options.source === "project") await fs.writeFile(path.join(cwd, ".env"), `AWS_REGION=${region}\n`);
		const home = path.join(cwd, "home");
		await fs.mkdir(home);
		const configPath = path.join(cwd, "aws-config");
		const credentialsPath = path.join(cwd, "aws-credentials");
		await fs.writeFile(credentialsPath, "");
		if (scenario === "aws-sso") {
			await fs.writeFile(
				configPath,
				`[profile test-sso]\nsso_start_url = https://example.awsapps.com/start\nsso_region = ${region}\nsso_account_id = 123456789012\nsso_role_name = TestRole\n`,
			);
			const cacheDir = path.join(home, ".aws", "sso", "cache");
			await fs.mkdir(cacheDir, { recursive: true });
			await fs.writeFile(
				path.join(cacheDir, "token.json"),
				JSON.stringify({
					startUrl: "https://example.awsapps.com/start",
					accessToken: "sso-test-bearer-token",
					expiresAt: "2099-01-01T00:00:00Z",
				}),
			);
		}
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "",
			HOME: home,
			USERPROFILE: home,
			GJC_CONFIG_DIR: path.join(cwd, "config"),
			GJC_CODING_AGENT_DIR: path.join(cwd, "agent"),
			AWS_EC2_METADATA_DISABLED: "true",
			AWS_CONFIG_FILE: configPath,
			AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
			AWS_BEARER_TOKEN_BEDROCK: scenario === "bedrock-bearer" ? "bedrock-test-secret" : "",
			AWS_ACCESS_KEY_ID: scenario === "bedrock-sigv4" ? "test-access-key" : "",
			AWS_SECRET_ACCESS_KEY: scenario === "bedrock-sigv4" ? "test-secret-key" : "",
			AWS_SESSION_TOKEN: scenario === "bedrock-sigv4" ? "test-session-token" : "",
			KIRO_API_KEY: scenario.startsWith("kiro-") ? "ksk_test-secret" : "",
		};
		if (scenario === "aws-imds") env.AWS_EC2_METADATA_DISABLED = "false";
		if (options.source !== "project") env.AWS_REGION = region;
		const proc = Bun.spawn(
			[
				process.execPath,
				import.meta.path,
				CHILD_FLAG,
				scenario,
				options.explicitBaseUrl ?? "",
				options.explicitRegionKind === "stateful"
					? "explicit-stateful"
					: options.source === "explicit"
						? "explicit-empty"
						: "",
				options.redirect ? "redirect" : "",
				options.forcedToolChoice ? "forced-tool-choice" : "",
				region,
			],
			{ cwd, env, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout.trim()) as ProbeResult;
	}

	const attackerRegion = "amazonaws.com@attacker.example/";

	describe("AWS region credential destination", () => {
		test.each([
			"aws-sso",
			"aws-imds",
			"bedrock-bearer",
			"bedrock-sigv4",
			"codewhisperer",
			"kiro-discovery",
			"kiro-stream",
		] as const)("fails closed instead of following a credential-bearing %s redirect", async scenario => {
			const result = await probe(scenario, "us-east-1", { redirect: true });
			expect(result.redirect?.initialRequests).toBeGreaterThan(0);
			expect(result.redirect?.targetRequests).toHaveLength(0);
			expect(result.error).not.toBeNull();
		});

		test("rejects an OIDC authority injection before sending a registered client secret", async () => {
			const result = await probe("kiro-oidc-device", attackerRegion);
			expect(result.fetches).toHaveLength(0);
			expect(result.error).toBe("Invalid AWS region: expected a lowercase ASCII DNS label.");
		});

		test.each([
			"kiro-oidc-device",
			"kiro-oidc-refresh",
		] as const)("fails closed instead of forwarding %s credentials across a redirect", async scenario => {
			const result = await probe(scenario, "us-east-1", { redirect: true });
			expect(result.redirect?.initialRequests).toBe(1);
			expect(result.redirect?.targetRequests).toHaveLength(0);
			expect(result.error).not.toBeNull();
		});

		test("fails closed instead of forwarding pollForToken credentials across a redirect", async () => {
			const result = await probe("kiro-oidc-poll", "us-east-1", { redirect: true });
			expect(result.redirect?.initialRequests).toBe(1);
			expect(result.redirect?.targetRequests).toHaveLength(0);
			expect(result.error).not.toBeNull();
		});

		test("rejects an SSO profile authority injection before sending its cached bearer token", async () => {
			const result = await probe("aws-sso", attackerRegion);
			expect(result.fetches).toHaveLength(0);
			expect(result.error).toBe("Invalid AWS region: expected a lowercase ASCII DNS label.");
		});

		test.each([
			"kiro-static-stream",
			"kiro-discovered-stream",
		] as const)("fails closed when a region-derived %s catalog model receives a redirect", async scenario => {
			const result = await probe(scenario, "us-east-1", { redirect: true });
			expect(result.redirect?.initialRequests).toBe(1);
			expect(result.redirect?.targetRequests).toHaveLength(0);
			expect(result.error).not.toBeNull();
		});

		test("fails closed when Bedrock's forced-tool-choice fallback receives a redirect", async () => {
			const result = await probe("bedrock-sigv4", "us-east-1", {
				redirect: true,
				forcedToolChoice: true,
			});
			expect(result.fetches).toHaveLength(2);
			expect(result.redirect?.initialRequests).toBe(1);
			expect(result.redirect?.targetRequests).toHaveLength(0);
			expect(result.error).not.toBeNull();
		});

		test.each([
			"bedrock-bearer",
			"bedrock-sigv4",
			"codewhisperer",
			"kiro-discovery",
			"kiro-stream",
		] as const)("rejects a project-aware authority injection before %s sends credentials", async scenario => {
			const result = await probe(scenario, attackerRegion, { source: "project" });
			expect(result.fetches).toHaveLength(0);
			expect(result.error).toBe("Invalid AWS region: expected a lowercase ASCII DNS label.");
		});

		test.each([
			["project", "bedrock-bearer"],
			["project", "bedrock-sigv4"],
			["project", "codewhisperer"],
			["project", "kiro-discovery"],
			["project", "kiro-stream"],
			["environment", "bedrock-bearer"],
			["environment", "bedrock-sigv4"],
			["environment", "codewhisperer"],
			["environment", "kiro-discovery"],
			["environment", "kiro-stream"],
			["explicit", "bedrock-bearer"],
			["explicit", "bedrock-sigv4"],
			["explicit", "codewhisperer"],
			["explicit", "kiro-discovery"],
			["explicit", "kiro-stream"],
		] as const)("rejects an empty %s region before %s sends credentials", async (source, scenario) => {
			const result = await probe(scenario, "", { source });
			expect(result.fetches).toHaveLength(0);
			expect(result.error).toBe("Invalid AWS region: expected a lowercase ASCII DNS label.");
		});

		test.each([
			"bedrock-bearer",
			"bedrock-sigv4",
			"codewhisperer",
			"kiro-discovery",
			"kiro-stream",
		] as const)("rejects a stateful non-string region before %s sends credentials", async scenario => {
			const result = await probe(scenario, "us-east-1", {
				source: "explicit",
				explicitRegionKind: "stateful",
			});
			expect(result.fetches).toHaveLength(0);
			expect(result.error).toBe("Invalid AWS region: expected a lowercase ASCII DNS label.");
		});

		test.each([
			"us-east-1.attacker.example",
			"us-east-1%2eattacker",
			"us-east-1/../attacker",
			"us-east-1@attacker",
			"US-EAST-1",
			"us-east-1 ",
			"us-east-1\t",
			"us-éast-1",
			"-us-east-1",
			"us-east-1-",
		])("rejects malformed region %p before Kiro API-key discovery", async region => {
			const result = await probe("kiro-discovery", region);
			expect(result.fetches).toHaveLength(0);
			expect(result.error).toBe("Invalid AWS region: expected a lowercase ASCII DNS label.");
		});

		test.each([
			"us-east-1\n",
			"us-east-1\r",
			"us-east-1\u2028",
			"us-east-1\u2029",
		])("rejects a trailing line terminator before Kiro API-key discovery", async region => {
			const result = await probe("kiro-discovery", region);
			expect(result.fetches).toHaveLength(0);
			expect(result.error).toBe("Invalid AWS region: expected a lowercase ASCII DNS label.");
		});

		test.each([
			[
				"aws-sso",
				"us-east-1",
				"https://portal.sso.us-east-1.amazonaws.com/federation/credentials?account_id=123456789012&role_name=TestRole",
				"none",
				null,
			],
			[
				"bedrock-bearer",
				"us-east-1",
				"https://bedrock-runtime.us-east-1.amazonaws.com/model/test-model/converse-stream",
				"bearer",
				null,
			],
			[
				"bedrock-sigv4",
				"us-gov-west-1",
				"https://bedrock-runtime.us-gov-west-1.amazonaws.com/model/test-model/converse-stream",
				"sigv4",
				null,
			],
			[
				"codewhisperer",
				"us-iso-east-1",
				"https://codewhisperer.us-iso-east-1.amazonaws.com/",
				"bearer",
				"AmazonCodeWhispererService.GenerateAssistantResponse",
			],
			[
				"kiro-discovery",
				"cn-north-1",
				"https://q.cn-north-1.amazonaws.com/",
				"bearer",
				"AmazonCodeWhispererService.ListAvailableModels",
			],
			[
				"kiro-stream",
				"eu-isoe-west-1",
				"https://q.eu-isoe-west-1.amazonaws.com/",
				"bearer",
				"AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
			],
		] as const)("preserves %s credential routing for region %s", async (scenario, region, url, authorization, target) => {
			const result = await probe(scenario, region);
			expect(result.error).toBeNull();
			expect(result.fetches).toHaveLength(1);
			expect(result.fetches[0]).toMatchObject({ url, authorization, target });
			if (scenario === "aws-sso") expect(result.fetches[0]?.ssoBearerToken).toBe(true);
		});

		test("preserves an explicit Kiro model baseUrl without consulting the implicit region", async () => {
			const result = await probe("kiro-stream", attackerRegion, {
				explicitBaseUrl: "https://trusted.gateway.example/kiro",
			});
			expect(result.error).toBeNull();
			expect(result.fetches).toEqual([
				expect.objectContaining({ host: "trusted.gateway.example", authorization: "bearer" }),
			]);
		});

		test("preserves redirect handling for an explicitly trusted Kiro model baseUrl", async () => {
			const result = await probe("kiro-stream", attackerRegion, {
				explicitBaseUrl: "https://trusted.gateway.example/kiro",
				redirect: true,
			});
			expect(result.redirect?.initialRequests).toBe(1);
			expect(result.redirect?.targetRequests).toHaveLength(1);
			expect(result.error).toBeNull();
		});
	});
}
