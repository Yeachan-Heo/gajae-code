import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai";
import type { ModelRegistry } from "../src/config/model-registry";
import { RetiredImageSecretGateError, runRetiredImageSecretGate } from "../src/config/retired-image-secret-gate";
import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import type { ReadonlySessionManager } from "../src/session/session-manager";
import { createImageGenTool, getImageGenTools } from "../src/tools/image-gen";

const originalFetch = global.fetch;
const environmentKeys = [
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"ALIBABA_TOKEN_PLAN_API_KEY",
] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]])) as Record<
	string,
	string | undefined
>;

const tempDirs: string[] = [];

const activeModel = {
	id: "gpt-5.5",
	name: "GPT 5.5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
} as Model;

function makeContext(modelRegistry: ModelRegistry, model: Model = activeModel): CustomToolContext {
	return {
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "project-authority-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry,
		model,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

async function makeWorkspace(): Promise<{ cwd: string; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-image-project-authority-"));
	tempDirs.push(root);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	return { cwd, agentDir };
}

async function expectProjectConfigBlocked(action: Promise<unknown>, secrets: readonly string[] = []): Promise<void> {
	let caught: unknown;
	try {
		await action;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(RetiredImageSecretGateError);
	if (!(caught instanceof RetiredImageSecretGateError)) return;
	expect(caught.source).toBe("project-config");
	expect(caught.message).not.toContain("other-endpoint-reference");
	for (const secret of secrets) expect(caught.message).not.toContain(secret);
}

afterEach(async () => {
	global.fetch = originalFetch;
	for (const key of environmentKeys) {
		const value = originalEnvironment[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const directory of tempDirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("image project credential authority", () => {
	it("does not consult protected credentials, environment fallbacks, or the network for selectorless custom intent", async () => {
		for (const key of environmentKeys) process.env[key] = `environment-value-for-${key}`;
		let lookupCount = 0;
		let networkCount = 0;
		const registry = {
			getApiKey: async () => {
				lookupCount++;
				return "protected-key-that-must-not-be-used";
			},
			getApiKeyForProvider: async () => {
				lookupCount++;
				return "protected-provider-key-that-must-not-be-used";
			},
		} as unknown as ModelRegistry;
		const fetchMock: typeof fetch = (async () => {
			networkCount++;
			return new Response("unexpected network dispatch", { status: 500 });
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const config = {
			provider: "custom" as const,
			model: "project-image-model",
			customUrl: "https://project-images.example.invalid/v1",
		};
		expect(await getImageGenTools(registry, activeModel, config, "project-authority-session")).toEqual([]);

		const tool = createImageGenTool(config);
		await expect(
			tool.execute("project-authority-call", { subject: "a cat" }, undefined, makeContext(registry)),
		).rejects.toThrow("No image API credentials found");
		expect(lookupCount).toBe(0);
		expect(networkCount).toBe(0);
	});

	it("rejects an endpoint/reference mismatch at the project configuration gate before dispatch", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const configPath = path.join(cwd, ".gjc", "config.yml");
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		const configText = [
			"providers:",
			"  image: custom",
			"  imageModel: project-image-model",
			"  imageCustomUrl: https://project-images.example.invalid/v1",
			"  imageCredentialReference: https://other-endpoint-reference.example.invalid/v1#credential",
			"",
		].join("\n");
		await fs.writeFile(configPath, configText);
		let networkCount = 0;
		const fetchMock: typeof fetch = (async () => {
			networkCount++;
			return new Response("unexpected network dispatch", { status: 500 });
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		await expectProjectConfigBlocked(runRetiredImageSecretGate({ cwd, agentDir }), [
			"https://other-endpoint-reference.example.invalid/v1#credential",
		]);
		expect(await fs.readFile(configPath, "utf8")).toBe(configText);
		expect(networkCount).toBe(0);
	});

	it("rejects every project image routing field before any downstream credential lookup or network dispatch", async () => {
		const routes = [
			{ key: "image", value: "custom" },
			{ key: "image", value: "openai" },
			{ key: "image", value: "gemini" },
			{ key: "imageModel", value: "project-image-model" },
			{ key: "imageCustomUrl", value: "https://project-images.example.invalid/v1" },
		] as const;
		for (const route of routes) {
			const { cwd, agentDir } = await makeWorkspace();
			const configPath = path.join(cwd, ".gjc", "config.yml");
			await fs.mkdir(path.dirname(configPath), { recursive: true });
			const configText = ["providers:", `  ${route.key}: ${route.value}`, "safeSetting: retained", ""].join("\n");
			await fs.writeFile(configPath, configText);

			let lookupCount = 0;
			let networkCount = 0;
			const registry = {
				getApiKey: async () => {
					lookupCount++;
					return "project-route-key";
				},
			} as unknown as ModelRegistry;
			const fetchMock: typeof fetch = (async () => {
				networkCount++;
				return new Response("unexpected network dispatch", { status: 500 });
			}) as unknown as typeof fetch;
			fetchMock.preconnect = originalFetch.preconnect;
			global.fetch = fetchMock;

			await expectProjectConfigBlocked(
				(async () => {
					await runRetiredImageSecretGate({ cwd, agentDir });
					await getImageGenTools(
						registry,
						activeModel,
						{
							provider: "custom",
							model: "downstream-model",
							customUrl: "https://downstream-images.example.invalid/v1",
							credentialSelector: { kind: "id", value: "downstream-selector" },
						},
						"project-route-session",
					);
				})(),
				[],
			);
			expect(lookupCount).toBe(0);
			expect(networkCount).toBe(0);
			expect(await fs.readFile(configPath, "utf8")).toBe(configText);
		}
	});

	it("allows trusted global image routing when it carries an explicit user credential selector", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const configPath = path.join(agentDir, "config.yml");
		const configText = [
			"providers:",
			"  image: custom",
			"  imageModel: trusted-global-image-model",
			"  imageCustomUrl: https://trusted-global-images.example.invalid/v1",
			"  imageCredentialSelector:",
			"    kind: id",
			"    value: trusted-user-selector",
			"",
		].join("\n");
		await fs.writeFile(configPath, configText);
		await runRetiredImageSecretGate({ cwd, agentDir });
		expect(await fs.readFile(configPath, "utf8")).toBe(configText);

		const selectors: Array<{ sessionId?: string; selector?: { kind: string; value: string } }> = [];
		let requestUrl: string | undefined;
		const authorizationHeaders: string[] = [];
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			const authorization = new Headers(init?.headers).get("authorization");
			if (authorization !== null) authorizationHeaders.push(authorization);
			return new Response(
				JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "status-safe" }] }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const registry = {
			getApiKey: async (
				_model: Model,
				_sessionId?: string,
				options?: { credentialSelector?: { kind: string; value: string } },
			) => {
				selectors.push({ sessionId: _sessionId, selector: options?.credentialSelector });
				return "trusted-global-image-key";
			},
			getSessionCredentialType: () => "api_key",
		} as unknown as ModelRegistry;
		const config = {
			provider: "custom" as const,
			model: "trusted-global-image-model",
			customUrl: "https://trusted-global-images.example.invalid/v1",
			credentialSelector: { kind: "id" as const, value: "trusted-user-selector" },
		};
		const tools = await getImageGenTools(registry, activeModel, config, "trusted-global-session");
		expect(tools).toHaveLength(1);
		const result = await tools[0]!.execute(
			"trusted-global-call",
			{ subject: "a cat" },
			undefined,
			makeContext(registry),
		);

		expect(requestUrl).toBe("https://trusted-global-images.example.invalid/v1/responses");
		expect(authorizationHeaders).toEqual(["Bearer trusted-global-image-key"]);
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.imageCount).toBe(0);
		expect(result.details?.responseText).toBe("status-safe");
		expect(selectors).toEqual([
			{ sessionId: "trusted-global-session", selector: { kind: "id", value: "trusted-user-selector" } },
			{ sessionId: "trusted-global-session", selector: { kind: "id", value: "trusted-user-selector" } },
		]);
	});
});
