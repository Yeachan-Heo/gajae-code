import { afterEach, describe, expect, setDefaultTimeout, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerOwnedDeletionRoot } from "../../../scripts/safe-cleanup";
import { withModelPresetRegistryTestTrust } from "../src/config/internal/model-preset-registry-test-support";
import {
	canonicalModelPresetRegistryJson,
	getModelPresetRegistryStatus as getModelPresetRegistryStatusImpl,
	loadAcceptedModelPresetRegistry as loadAcceptedModelPresetRegistryImpl,
	type ModelPresetRegistryDependencies,
	type ModelPresetRegistryManifest,
	type ModelPresetRegistryPresets,
	type ModelPresetRegistryProfiles,
	type ModelPresetRegistrySnapshot,
	type ModelPresetRegistryTrustedKey,
	refreshModelPresetRegistry as refreshModelPresetRegistryImpl,
	refreshModelPresetRegistryInBackground,
	rollbackModelPresetRegistry as rollbackModelPresetRegistryImpl,
	setModelPresetRegistryDisabled,
	setModelPresetRegistryPin as setModelPresetRegistryPinImpl,
} from "../src/config/model-preset-registry";
import { validateModelProfileName } from "../src/config/model-profile-contract";
import { mergeModelProfiles } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";

const directories: string[] = [];
const ownedDirectoryDisposers: Array<() => void> = [];
const testTrustRunners = new Map<string, <T>(operation: () => T) => T>();
setDefaultTimeout(30_000);
const manifestUrl = "https://presets.gajae-code.test/latest.json";

async function createTrackedDirectory(prefix: string): Promise<string> {
	const directory = path.join(os.tmpdir(), `${prefix}${crypto.randomUUID()}`);
	ownedDirectoryDisposers.push(registerOwnedDeletionRoot(directory));
	await fs.mkdir(directory, { recursive: true });
	directories.push(directory);
	return directory;
}

function refreshModelPresetRegistry(options: Parameters<typeof refreshModelPresetRegistryImpl>[0] = {}) {
	const run = options.agentDir ? testTrustRunners.get(options.agentDir) : undefined;
	return run ? run(() => refreshModelPresetRegistryImpl(options)) : refreshModelPresetRegistryImpl(options);
}

function loadAcceptedModelPresetRegistry(
	agentDir?: string,
	dependencies?: Parameters<typeof loadAcceptedModelPresetRegistryImpl>[1],
) {
	const run = agentDir ? testTrustRunners.get(agentDir) : undefined;
	return run
		? run(() => loadAcceptedModelPresetRegistryImpl(agentDir, dependencies))
		: loadAcceptedModelPresetRegistryImpl(agentDir, dependencies);
}

function getModelPresetRegistryStatus(options: Parameters<typeof getModelPresetRegistryStatusImpl>[0] = {}) {
	const run = options.agentDir ? testTrustRunners.get(options.agentDir) : undefined;
	return run ? run(() => getModelPresetRegistryStatusImpl(options)) : getModelPresetRegistryStatusImpl(options);
}

function setModelPresetRegistryPin(options: Parameters<typeof setModelPresetRegistryPinImpl>[0]) {
	const run = options.agentDir ? testTrustRunners.get(options.agentDir) : undefined;
	return run ? run(() => setModelPresetRegistryPinImpl(options)) : setModelPresetRegistryPinImpl(options);
}

function rollbackModelPresetRegistry(options: Parameters<typeof rollbackModelPresetRegistryImpl>[0]) {
	const run = options.agentDir ? testTrustRunners.get(options.agentDir) : undefined;
	return run ? run(() => rollbackModelPresetRegistryImpl(options)) : rollbackModelPresetRegistryImpl(options);
}
const productionManifestV1 = `{"schemaVersion":"1.0.0","signature":{"algorithm":"Ed25519","keyId":"registry-root-2026-01","value":"72hjU+GP8jsfCft0XotlRDhBa1sxPGPzySVATT1wwdT/h3Cb+Ylj7DI0ydiiAqSbDtFPhOmZvhFxpLeUQ5jFBw=="},"signed":{"compatibility":{"consumerContract":{"maxVersion":"1.0.0","minVersion":"1.0.0"}},"contents":{"presets":{"bytes":1230434,"count":4271,"path":"revisions/00000001/presets.json","sha256":"a73a9d0876198475902e7b87ac59dce37746025b35711767bd7ba6afe4104d96"},"profiles":{"bytes":19679,"count":58,"path":"revisions/00000001/profiles.json","sha256":"8befc86c52621d18f71ad141cd194329e8299bcfd50772faaf68b7f9c5b379cd"}},"provenance":{"generatedAt":"2026-08-24T09:41:42.000Z","generatedBy":"gajae-code-presets/scripts/import-upstream.mjs@1","sourcePaths":["packages/ai/src/models.json","packages/coding-agent/src/config/model-profiles.ts"],"sourceRepository":"https://github.com/Yeachan-Heo/gajae-code","sourceRevision":"65d0d2fdae36a4512959a6a8c143339b8ec98c58"},"publishedAt":"2026-08-24T09:41:42.000Z","registryRevision":1,"revision":"00000001","snapshot":{"bytes":819,"count":1,"path":"revisions/00000001/snapshot.json","sha256":"3e3e9e8d114be2b29184b83ed9c3321902a48202cda14ec765a73298c383c030"}}}`;
const productionSnapshotV1 = `{"compatibility":{"consumerContract":{"maxVersion":"1.0.0","minVersion":"1.0.0"}},"contents":{"presets":{"bytes":1230434,"count":4271,"path":"revisions/00000001/presets.json","sha256":"a73a9d0876198475902e7b87ac59dce37746025b35711767bd7ba6afe4104d96"},"profiles":{"bytes":19679,"count":58,"path":"revisions/00000001/profiles.json","sha256":"8befc86c52621d18f71ad141cd194329e8299bcfd50772faaf68b7f9c5b379cd"}},"provenance":{"generatedAt":"2026-08-24T09:41:42.000Z","generatedBy":"gajae-code-presets/scripts/import-upstream.mjs@1","sourcePaths":["packages/ai/src/models.json","packages/coding-agent/src/config/model-profiles.ts"],"sourceRepository":"https://github.com/Yeachan-Heo/gajae-code","sourceRevision":"65d0d2fdae36a4512959a6a8c143339b8ec98c58"},"registryRevision":1,"revision":"00000001","schemaVersion":"1.0.0"}`;

function sha256(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}
function descriptor(pathname: string, body: string, count: number) {
	return { path: pathname, sha256: sha256(body), bytes: Buffer.byteLength(body), count };
}
function registryProfile(id: string, selector = "provider/remote-model") {
	return {
		id,
		displayName: id,
		providerGroup: "TEST",
		requiredProviders: ["provider"],
		roleBindings: { default: selector },
	};
}
function registryPreset(id: string, contextWindow = 8192, extras: { contextPromotionTarget?: string } = {}) {
	return {
		id,
		provider: "provider",
		name: id,
		api: "openai-completions" as const,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 2048,
		...extras,
	};
}

interface RegistryFixture {
	agentDir: string;
	privateKey: crypto.KeyObject;
	trustedKeys: Map<string, ModelPresetRegistryTrustedKey>;
	run<T>(operation: () => T): T;
}

interface SignedRegistryFixture {
	manifest: ModelPresetRegistryManifest;
	manifestBody: string;
	snapshot: ModelPresetRegistrySnapshot;
	snapshotBody: string;
	profiles: ModelPresetRegistryProfiles;
	profilesBody: string;
	presets: ModelPresetRegistryPresets;
	presetsBody: string;
}

async function fixture(): Promise<RegistryFixture> {
	const agentDir = await createTrackedDirectory("gjc-preset-registry-");
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	const trustedKey: ModelPresetRegistryTrustedKey = {
		keyId: "test-key",
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		validFrom: "2026-01-01T00:00:00.000Z",
	};
	const trustedKeys = new Map([[trustedKey.keyId, trustedKey]]);
	const run = <T>(operation: () => T): T => withModelPresetRegistryTestTrust(agentDir, trustedKeys, operation);
	testTrustRunners.set(agentDir, run);
	return { agentDir, privateKey, trustedKeys, run };
}

function signedRegistry(
	privateKey: crypto.KeyObject,
	revision: number,
	profileEntries = [registryProfile("remote")],
	presetEntries: ModelPresetRegistryPresets["presets"] = [registryPreset("remote-model")],
	compatibility = { consumerContract: { minVersion: "1.0.0", maxVersion: "1.0.0" } },
	dynamicProviders: string[] = [],
	keyId = "test-key",
): SignedRegistryFixture {
	const revisionId = String(revision).padStart(8, "0");
	const profiles: ModelPresetRegistryProfiles = {
		schemaVersion: "1.0.0",
		revision: revisionId,
		dynamicProviders,
		profiles: profileEntries,
	};
	const presets: ModelPresetRegistryPresets = {
		schemaVersion: "1.0.0",
		revision: revisionId,
		presets: presetEntries,
	};
	const profilesBody = canonicalModelPresetRegistryJson(profiles);
	const presetsBody = canonicalModelPresetRegistryJson(presets);
	const contents = {
		profiles: descriptor(`revisions/${revisionId}/profiles.json`, profilesBody, profiles.profiles.length),
		presets: descriptor(`revisions/${revisionId}/presets.json`, presetsBody, presets.presets.length),
	};
	const provenance = {
		sourceRepository: "https://github.com/Yeachan-Heo/gajae-code" as const,
		sourceRevision: "65d0d2fdae36a4512959a6a8c143339b8ec98c58",
		sourcePaths: ["packages/coding-agent/src/config/model-profiles.ts"],
		generatedBy: "test@1",
		generatedAt: "2026-08-24T09:41:42.000Z",
	};
	const snapshot: ModelPresetRegistrySnapshot = {
		schemaVersion: "1.0.0",
		registryRevision: revision,
		revision: revisionId,
		compatibility,
		provenance,
		contents,
	};
	const snapshotBody = canonicalModelPresetRegistryJson(snapshot);
	const signed = {
		registryRevision: revision,
		revision: revisionId,
		publishedAt: "2026-08-24T09:41:42.000Z",
		compatibility,
		snapshot: descriptor(`revisions/${revisionId}/snapshot.json`, snapshotBody, 1),
		contents,
		provenance,
	};
	const signature = crypto
		.sign(null, Buffer.from(canonicalModelPresetRegistryJson(signed)), privateKey)
		.toString("base64");
	const manifest: ModelPresetRegistryManifest = {
		schemaVersion: "1.0.0",
		signed,
		signature: { algorithm: "Ed25519", keyId, value: signature },
	};
	return {
		manifest,
		manifestBody: canonicalModelPresetRegistryJson(manifest),
		snapshot,
		snapshotBody,
		profiles,
		profilesBody,
		presets,
		presetsBody,
	};
}

function registryFetch(registry: SignedRegistryFixture, observedHeaders?: Headers[]): typeof fetch {
	let calls = 0;
	return (async (_input, init) => {
		calls++;
		observedHeaders?.push(new Headers(init?.headers));
		if (calls === 1) return new Response(registry.manifestBody, { headers: { etag: '"revision"' } });
		if (calls === 2) return new Response(registry.snapshotBody);
		if (calls === 3) return new Response(registry.profilesBody);
		return new Response(registry.presetsBody);
	}) as typeof fetch;
}
async function accept(
	data: RegistryFixture,
	registry: SignedRegistryFixture,
	fetchImpl = registryFetch(registry),
	overrides: ModelPresetRegistryDependencies = {},
) {
	return data.run(() =>
		refreshModelPresetRegistry({
			...overrides,
			agentDir: data.agentDir,
			manifestUrl,
			fetch: fetchImpl,
		}),
	);
}

afterEach(async () => {
	for (const directory of directories) testTrustRunners.delete(directory);
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
	for (const dispose of ownedDirectoryDisposers.splice(0)) dispose();
});

describe("signed model preset registry", () => {
	test("does not expose test trust support through package exports", () => {
		expect(() =>
			Bun.resolveSync("@gajae-code/coding-agent/config/model-preset-registry-test-support", import.meta.dir),
		).toThrow();
		expect(() =>
			Bun.resolveSync("@gajae-code/coding-agent/config/model-preset-registry-test-state", import.meta.dir),
		).toThrow();
		expect(() =>
			Bun.resolveSync(
				"@gajae-code/coding-agent/config/internal/model-preset-registry-test-support",
				import.meta.dir,
			),
		).toThrow();
	});

	test("matches producer canonical JSON ordering and rejects lone surrogates", () => {
		expect(canonicalModelPresetRegistryJson({ "\ue000": 1, 𐀀: 2, negativeZero: -0 })).toBe(
			'{"negativeZero":0,"𐀀":2,"":1}',
		);
		expect(() => canonicalModelPresetRegistryJson("\ud800")).toThrow(/lone high surrogate/i);
	});

	test("accepts the exact producer revision-1 manifest signature and snapshot binding", async () => {
		const agentDir = await createTrackedDirectory("gjc-preset-production-contract-");
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			if (calls === 1) return new Response(productionManifestV1);
			if (calls === 2) return new Response(productionSnapshotV1);
			return new Response("");
		}) as unknown as typeof fetch;
		await expect(refreshModelPresetRegistry({ agentDir, manifestUrl, fetch: fetchImpl })).rejects.toThrow(
			/profiles size mismatch/i,
		);
		expect(calls).toBe(3);
		expect(getModelPresetRegistryStatus({ agentDir })).toMatchObject({ cacheHealth: "empty", source: "embedded" });
	});

	test("accepts a credential-free HTTPS manifest override with same-origin signed content", async () => {
		const data = await fixture();
		const registry = signedRegistry(data.privateKey, 1);
		await expect(
			data.run(() =>
				refreshModelPresetRegistryImpl({
					agentDir: data.agentDir,
					manifestUrl: "https://registry.example.test/latest.json",
					fetch: registryFetch(registry),
				}),
			),
		).resolves.toMatchObject({ status: "updated", revision: 1 });
	});

	test("rejects manifest URL query and fragment components before fetch", async () => {
		const data = await fixture();
		const fetchImpl = vi.fn(async () => new Response("must not fetch")) as unknown as typeof fetch;
		for (const unsafeUrl of [
			"https://registry.example.test/latest.json?token=secret",
			"https://registry.example.test/latest.json#secret",
		]) {
			await expect(
				data.run(() =>
					refreshModelPresetRegistryImpl({
						agentDir: data.agentDir,
						manifestUrl: unsafeUrl,
						fetch: fetchImpl,
					}),
				),
			).rejects.toThrow(/credential-free HTTPS/i);
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test("accepts the exact signed manifest/snapshot/content contract and merges embedded < registry < user", async () => {
		const data = await fixture();
		const registry = signedRegistry(
			data.privateKey,
			1,
			[registryProfile("codex-medium", "provider/remote-model"), registryProfile("remote")],
			[
				registryPreset("remote-model"),
				{ ...registryPreset("MiniMax-M2.5", 12_345), provider: "alibaba-token-plan" },
				{ ...registryPreset("registry-only-model", 24_680), provider: "alibaba-token-plan" },
				{ ...registryPreset("configured-model", 32_000), provider: "configured-provider" },
				{ ...registryPreset("mismatched-model", 32_000), provider: "mismatched-provider" },
				{ ...registryPreset("gpt-4o-mini", 64_000), provider: "openai" },
				{ ...registryPreset("claude-sonnet-4-5", 72_000), provider: "anthropic" },
			],
		);
		expect(await accept(data, registry)).toMatchObject({ status: "updated", revision: 1, revisionId: "00000001" });
		expect(await Bun.file(path.join(data.agentDir, "models.yml")).exists()).toBe(false);
		const accepted = loadAcceptedModelPresetRegistry(data.agentDir, {});
		expect(accepted.profiles.get("remote")?.source).toBe("registry");
		expect(accepted.presets).toEqual(
			expect.arrayContaining([expect.objectContaining({ provider: "provider", id: "remote-model" })]),
		);
		await Bun.write(
			path.join(data.agentDir, "models.yml"),
			`providers:
  configured-provider:
    baseUrl: https://configured.example/v1
    api: openai-completions
    auth: none
    compat:
      supportsDeveloperRole: false
  mismatched-provider:
    baseUrl: https://mismatched.example/v1
    api: anthropic-messages
    auth: none
  openai:
    baseUrl: https://configured-openai.example/v1
    api: anthropic-messages
    auth: none
`,
		);
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			expect(modelRegistry.getModelProfile("remote")).toBeUndefined();
			expect(
				modelRegistry.getAll().find(model => model.provider === "provider" && model.id === "remote-model"),
			).toBe(undefined);
			expect(
				modelRegistry
					.getAll()
					.find(model => model.provider === "alibaba-token-plan" && model.id === "MiniMax-M2.5"),
			).toMatchObject({ contextWindow: 12_345, baseUrl: expect.stringContaining("https://") });
			expect(
				modelRegistry.getAll().find(model => model.provider === "openai" && model.id === "gpt-4o-mini"),
			).toMatchObject({
				contextWindow: 64_000,
				baseUrl: "https://configured-openai.example/v1",
				api: "anthropic-messages",
			});
			expect(
				modelRegistry.getAll().find(model => model.provider === "anthropic" && model.id === "claude-sonnet-4-5"),
			).toMatchObject({ contextWindow: 72_000, api: "anthropic-messages" });
			expect(
				modelRegistry
					.getAll()
					.find(model => model.provider === "alibaba-token-plan" && model.id === "registry-only-model"),
			).toMatchObject({
				contextWindow: 24_680,
				baseUrl: expect.stringContaining("https://"),
				compat: expect.objectContaining({ supportsDeveloperRole: false }),
			});
			expect(
				modelRegistry
					.getAll()
					.find(model => model.provider === "configured-provider" && model.id === "configured-model"),
			).toMatchObject({
				baseUrl: "https://configured.example/v1",
				compat: expect.objectContaining({ supportsDeveloperRole: false }),
			});
			expect(
				modelRegistry
					.getAll()
					.find(model => model.provider === "mismatched-provider" && model.id === "mismatched-model"),
			).toBeUndefined();
			expect(modelRegistry.getActiveProviders().some(provider => provider.provider === "mismatched-provider")).toBe(
				false,
			);
		} finally {
			authStorage.close();
		}
		const merged = mergeModelProfiles(
			{ remote: { required_providers: ["user"], model_mapping: { default: "user/model" } } },
			accepted.profiles,
		);
		expect(merged.get("codex-medium")?.modelMapping.default).toBe("provider/remote-model");
		expect(merged.get("remote")?.modelMapping.default).toBe("user/model");
	});

	test("accepts exact registry model ids that end in a thinking-level token", async () => {
		const data = await fixture();
		const exactId = "remote-model:minimal";
		const registry = signedRegistry(
			data.privateKey,
			1,
			[registryProfile("remote", `provider/${exactId}`)],
			[registryPreset(exactId)],
		);

		await expect(accept(data, registry)).resolves.toMatchObject({ status: "updated", revision: 1 });
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).profiles.get("remote")?.modelMapping.default).toBe(
			`provider/${exactId}`,
		);
	});

	test("rejects registry additions when provider transport templates are ambiguous", async () => {
		const data = await fixture();
		const registry = signedRegistry(
			data.privateKey,
			1,
			[],
			[{ ...registryPreset("ambiguous-model"), provider: "kimi-code" }],
		);
		await expect(accept(data, registry)).resolves.toMatchObject({ status: "updated", revision: 1 });
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			expect(modelRegistry.find("kimi-code", "ambiguous-model")).toBeUndefined();
		} finally {
			authStorage.close();
		}
	});

	test("preserves OAuth shaping for registry additions with explicit transport and no template", async () => {
		const data = await fixture();
		const registry = signedRegistry(
			data.privateKey,
			1,
			[],
			[{ ...registryPreset("oauth-model"), provider: "oauth-only" }],
		);
		await expect(accept(data, registry)).resolves.toMatchObject({ status: "updated", revision: 1 });
		await Bun.write(
			path.join(data.agentDir, "models.yml"),
			`providers:
  oauth-only:
    baseUrl: https://oauth.example/v1
    api: openai-completions
    auth: oauth
`,
		);
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			expect(modelRegistry.find("oauth-only", "oauth-model")).toMatchObject({
				api: "openai-completions",
				baseUrl: "https://oauth.example/v1",
				isOAuth: true,
			});
		} finally {
			authStorage.close();
		}
	});

	test("does not combine API-specific registry metadata with an explicit API transport", async () => {
		const data = await fixture();
		await expect(
			accept(
				data,
				signedRegistry(
					data.privateKey,
					1,
					[],
					[
						{
							...registryPreset("gpt-4o-mini", 64_000),
							provider: "openai",
						},
					],
				),
			),
		).resolves.toMatchObject({ status: "updated", revision: 1 });
		await Bun.write(
			path.join(data.agentDir, "models.yml"),
			`providers:
  openai:
    baseUrl: https://openai-proxy.example/v1
    api: anthropic-messages
    auth: none
`,
		);
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "mismatched-api-auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			const model = modelRegistry.find("openai", "gpt-4o-mini");
			expect(model).toMatchObject({
				api: "anthropic-messages",
				contextWindow: 64_000,
				baseUrl: "https://openai-proxy.example/v1",
			});
		} finally {
			authStorage.close();
		}
	});

	test("hydrates registry-only models from an openaiCompat transport", async () => {
		const data = await fixture();
		await expect(
			accept(
				data,
				signedRegistry(
					data.privateKey,
					1,
					[],
					[{ ...registryPreset("compat-model"), provider: "compat-provider" }],
				),
			),
		).resolves.toMatchObject({ status: "updated", revision: 1 });
		await Bun.write(
			path.join(data.agentDir, "models.yml"),
			`providers:
  compat-provider:
    openaiCompat:
      baseUrl: http://127.0.0.1:1234
`,
		);
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "openai-compat-auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			expect(modelRegistry.find("compat-provider", "compat-model")).toMatchObject({
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1234/v1",
				compat: expect.objectContaining({ supportsStore: false }),
			});
		} finally {
			authStorage.close();
		}
	});

	test("applies authHeader credentials to registry-only models", async () => {
		const data = await fixture();
		await expect(
			accept(
				data,
				signedRegistry(data.privateKey, 1, [], [{ ...registryPreset("header-model"), provider: "header-only" }]),
			),
		).resolves.toMatchObject({ status: "updated", revision: 1 });
		await Bun.write(
			path.join(data.agentDir, "models.yml"),
			`providers:
  header-only:
    baseUrl: https://headers.example/v1
    api: openai-completions
    apiKey: issue-header-key
    authHeader: true
`,
		);
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "header-auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			expect(modelRegistry.find("header-only", "header-model")).toMatchObject({
				baseUrl: "https://headers.example/v1",
				headers: { Authorization: "Bearer issue-header-key" },
			});
		} finally {
			authStorage.close();
		}
	});

	test("uses trusted provider environment endpoints for registry-only models", async () => {
		const data = await fixture();
		await expect(
			accept(
				data,
				signedRegistry(data.privateKey, 1, [], [{ ...registryPreset("env-model"), provider: "header-env" }]),
			),
		).resolves.toMatchObject({ status: "updated", revision: 1 });
		const previousBaseUrl = process.env.HEADER_ENV_BASE_URL;
		process.env.HEADER_ENV_BASE_URL = "https://headers-env.example/v1";
		await Bun.write(
			path.join(data.agentDir, "models.yml"),
			`providers:
  header-env:
    api: openai-completions
    apiKey: issue-env-key
    authHeader: true
`,
		);
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "env-auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			expect(modelRegistry.find("header-env", "env-model")).toMatchObject({
				baseUrl: "https://headers-env.example/v1",
				headers: { Authorization: "Bearer issue-env-key" },
			});
		} finally {
			authStorage.close();
			if (previousBaseUrl === undefined) delete process.env.HEADER_ENV_BASE_URL;
			else process.env.HEADER_ENV_BASE_URL = previousBaseUrl;
		}
	});

	test("retains registry profiles authorized for dynamic providers before discovery", async () => {
		const data = await fixture();
		const profile = registryProfile("dynamic-profile", "dynamic-provider/dynamic-model");
		await expect(
			accept(
				data,
				signedRegistry(
					data.privateKey,
					1,
					[profile],
					[],
					{ consumerContract: { minVersion: "1.0.0", maxVersion: "1.0.0" } },
					["dynamic-provider"],
				),
			),
		).resolves.toMatchObject({ status: "updated", revision: 1 });
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "dynamic-auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			expect(modelRegistry.getModelProfile("dynamic-profile")?.source).toBe("registry");
		} finally {
			authStorage.close();
		}
	});

	test("does not start recurring refresh for transient registries when disabled", async () => {
		const data = await fixture();
		let calls = 0;
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "transient-auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
						manifestUrl,
						startupDelayMs: 0,
						refreshIntervalMs: 1,
						fetch: (async () => {
							calls++;
							return new Response(null, { status: 304 });
						}) as unknown as typeof fetch,
					}),
			);
			await Bun.sleep(20);
			expect(calls).toBe(0);
			modelRegistry.dispose();
		} finally {
			authStorage.close();
		}
	});

	test("honors environment disable before reading corrupt control state", async () => {
		const data = await fixture();
		await Bun.write(path.join(data.agentDir, "model-presets", "control.json"), "{");
		const previous = process.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		process.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = "1";
		try {
			const accepted = loadAcceptedModelPresetRegistry(data.agentDir, {});
			expect(accepted).toMatchObject({ disabled: true });
			expect(accepted.error).toBeUndefined();
			expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
				disabled: true,
				source: "embedded",
				cacheHealth: "empty",
			});
		} finally {
			if (previous === undefined) delete process.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
			else process.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = previous;
		}
	});

	test("repairs malformed control while preserving valid accepted state", async () => {
		const data = await fixture();
		await expect(
			accept(data, signedRegistry(data.privateKey, 1, [registryProfile("stable")])),
		).resolves.toMatchObject({ status: "updated", revision: 1 });
		await Bun.write(path.join(data.agentDir, "model-presets", "control.json"), "{");
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				fetch: (async () => {
					throw new Error("offline");
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow("Registry refresh failed.");
		expect(await Bun.file(path.join(data.agentDir, "model-presets", "control.json")).json()).toEqual({
			version: 1,
			disabled: false,
		});
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(1);
	});

	test("rejects registry presets with incomplete thinking bounds", async () => {
		const data = await fixture();
		const partialThinking = {
			...registryPreset("partial-thinking"),
			thinking: { mode: "effort" as const, levels: ["low" as const] },
		} as ModelPresetRegistryPresets["presets"][number];
		await expect(accept(data, signedRegistry(data.privateKey, 1, [], [partialThinking]))).rejects.toThrow(
			/minLevel and maxLevel/i,
		);
	});

	test("rejects contradictory thinking bounds and defaults", async () => {
		const data = await fixture();
		const contradictory = {
			...registryPreset("contradictory-thinking"),
			thinking: {
				mode: "effort" as const,
				minLevel: "high" as const,
				maxLevel: "low" as const,
				defaultLevel: "medium" as const,
				levels: ["low", "high"] as const,
			},
		} as ModelPresetRegistryPresets["presets"][number];
		await expect(accept(data, signedRegistry(data.privateKey, 1, [], [contradictory]))).rejects.toThrow(
			/minLevel must not exceed maxLevel|defaultLevel must be within/i,
		);
		const outOfRange = {
			...registryPreset("out-of-range-thinking"),
			thinking: {
				mode: "effort" as const,
				minLevel: "low" as const,
				maxLevel: "high" as const,
				defaultLevel: "minimal" as const,
				levels: ["minimal", "low", "high"] as const,
			},
		} as ModelPresetRegistryPresets["presets"][number];
		await expect(accept(data, signedRegistry(data.privateKey, 1, [], [outOfRange]))).rejects.toThrow(
			/Thinking levels must stay within/i,
		);
	});

	test("rejects invalid signature, digest, compatibility, snapshot binding, and unknown fields without replacing LKG", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1, [registryProfile("stable")]));
		const invalidSignature = signedRegistry(data.privateKey, 2);
		invalidSignature.manifest.signature.value = Buffer.alloc(64).toString("base64");
		invalidSignature.manifestBody = canonicalModelPresetRegistryJson(invalidSignature.manifest);
		await expect(accept(data, invalidSignature)).rejects.toThrow(/signature verification/i);
		const digestMismatch = signedRegistry(data.privateKey, 2);
		digestMismatch.profilesBody += " ";
		await expect(accept(data, digestMismatch)).rejects.toThrow(/size mismatch|digest mismatch/i);
		const incompatible = signedRegistry(data.privateKey, 2, undefined, undefined, {
			consumerContract: { minVersion: "2.0.0", maxVersion: "3.0.0" },
		});
		await expect(accept(data, incompatible)).rejects.toThrow(/incompatible/i);
		const mismatch = signedRegistry(data.privateKey, 2);
		mismatch.snapshot.contents.profiles.sha256 = "0".repeat(64);
		mismatch.snapshotBody = canonicalModelPresetRegistryJson(mismatch.snapshot);
		await expect(accept(data, mismatch)).rejects.toThrow(/digest mismatch|does not match/i);
		const unknown = signedRegistry(data.privateKey, 2);
		unknown.profilesBody = canonicalModelPresetRegistryJson({ ...unknown.profiles, apiKey: "DO-NOT-ACCEPT" });
		await expect(accept(data, unknown)).rejects.toThrow(/schema rejected|digest mismatch|size mismatch/i);
		const accepted = loadAcceptedModelPresetRegistry(data.agentDir, {});
		expect(accepted.revision).toBe(1);
		expect(accepted.profiles.has("stable")).toBe(true);
	});

	test("propagates corrupt accepted registry state through the local model registry error surface", async () => {
		const data = await fixture();
		await expect(
			accept(data, signedRegistry(data.privateKey, 1, [registryProfile("registry-only")])),
		).resolves.toMatchObject({ status: "updated", revision: 1 });
		await Bun.write(path.join(data.agentDir, "model-presets", "state.json"), '{"corrupt":true}');
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			expect(modelRegistry.getError()?.message).toMatch(/model-preset-registry|registry cache/i);
			expect(() =>
				validateModelProfileName("registry-only", modelRegistry.getModelProfiles(), modelRegistry.getError()),
			).toThrow(/model profile registry/i);
		} finally {
			authStorage.close();
		}
	});

	test("preserves explicit OAuth shaping when registry metadata overlays an existing model", async () => {
		const data = await fixture();
		await expect(
			accept(
				data,
				signedRegistry(data.privateKey, 1, [], [{ ...registryPreset("gpt-4o-mini"), provider: "openai" }]),
			),
		).resolves.toMatchObject({ status: "updated", revision: 1 });
		await Bun.write(
			path.join(data.agentDir, "models.yml"),
			`providers:
  openai:
    baseUrl: https://oauth-openai.example/v1
    api: openai-completions
    auth: oauth
`,
		);
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "auth.db"));
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			expect(modelRegistry.find("openai", "gpt-4o-mini")).toMatchObject({ isOAuth: true });
		} finally {
			authStorage.close();
		}
	});

	test("rejects malicious roles, duplicate identities, noncanonical bytes, oversized streams, redirects, and timeout", async () => {
		const data = await fixture();
		const invalidRole = signedRegistry(data.privateKey, 1);
		invalidRole.profiles.profiles[0]!.roleBindings = { default: "provider/model", shell: "sh/curl" } as never;
		invalidRole.profilesBody = canonicalModelPresetRegistryJson(invalidRole.profiles);
		await expect(accept(data, invalidRole)).rejects.toThrow(/schema rejected|digest mismatch|size mismatch/i);
		const duplicates = signedRegistry(data.privateKey, 1, [registryProfile("same"), registryProfile("same")]);
		await expect(accept(data, duplicates)).rejects.toThrow(/duplicate|schema rejected/i);
		const reserved = signedRegistry(data.privateKey, 1, [registryProfile("system-shadow")]);
		await expect(accept(data, reserved)).rejects.toThrow(/reserved profile id namespace/i);
		const formatControl = signedRegistry(data.privateKey, 1, [
			{ ...registryProfile("format-control"), displayName: "trusted\u202Eliame" },
		]);
		await expect(accept(data, formatControl)).rejects.toThrow(/schema rejected/i);
		const promotionSpoof = signedRegistry(data.privateKey, 1, undefined, [
			{ ...registryPreset("spoof"), contextPromotionTarget: "provider/\u202Emodel" },
		]);
		await expect(accept(data, promotionSpoof)).rejects.toThrow(/schema rejected/i);
		const slashedProvider = signedRegistry(data.privateKey, 1, undefined, [
			{ ...registryPreset("model"), provider: "foo/bar" },
		]);
		await expect(accept(data, slashedProvider)).rejects.toThrow(/schema rejected/i);
		const confusable = signedRegistry(data.privateKey, 1, undefined, [
			{ ...registryPreset("model"), provider: "scope" },
			{ ...registryPreset("mоdel"), provider: "scope" },
		]);
		await expect(accept(data, confusable)).rejects.toThrow(/confusable preset selector/i);
		const noncanonical = signedRegistry(data.privateKey, 1);
		noncanonical.manifestBody = JSON.stringify(noncanonical.manifest, null, 2);
		await expect(accept(data, noncanonical)).rejects.toThrow(/canonical/i);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				maxManifestBytes: 4,
				fetch: (async () => new Response("oversized")) as unknown as typeof fetch,
			}),
		).rejects.toThrow(/byte limit/i);
		const redirectedResponse = new Response(noncanonical.manifestBody);
		Object.defineProperty(redirectedResponse, "url", { value: "https://evil.example/latest.json" });
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				fetch: (async () => redirectedResponse) as unknown as typeof fetch,
			}),
		).rejects.toThrow(/URL changed/i);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				timeoutMs: 5,
				fetch: (async (_input, init) => {
					const pending = Promise.withResolvers<Response>();
					init?.signal?.addEventListener("abort", () => pending.reject(init.signal?.reason), { once: true });
					return pending.promise;
				}) as typeof fetch,
			}),
		).rejects.toThrow(/timed out/i);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				fetch: (async () => {
					throw new Error("token=SUPERSECRET https://private.example/path");
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow("Registry refresh failed.");
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir }).lastError).not.toContain("SUPERSECRET");
	});

	test("rejects downgrade and same-revision equivocation", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 2));
		await expect(accept(data, signedRegistry(data.privateKey, 1))).rejects.toThrow(/downgrade/i);
		await expect(accept(data, signedRegistry(data.privateKey, 2, [registryProfile("changed")]))).rejects.toThrow(
			/equivocation/i,
		);
	});

	test("rejects noncanonical Ed25519 signature encoding of an otherwise valid manifest", async () => {
		const data = await fixture();
		const registry = signedRegistry(data.privateKey, 1);
		const canonical = registry.manifest.signature.value;
		expect(canonical).toMatch(/^[A-Za-z0-9+/]{86}==$/);
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		const lastDataChar = canonical[85]!;
		const alphabetIndex = alphabet.indexOf(lastDataChar);
		expect(alphabetIndex).toBeGreaterThanOrEqual(0);
		const mutatedChar = alphabet[alphabetIndex ^ 1]!;
		expect(mutatedChar).not.toBe(lastDataChar);
		const mutatedValue = `${canonical.slice(0, 85)}${mutatedChar}==`;
		expect(Buffer.from(mutatedValue, "base64").equals(Buffer.from(canonical, "base64"))).toBe(true);
		registry.manifest.signature.value = mutatedValue;
		registry.manifestBody = canonicalModelPresetRegistryJson(registry.manifest);
		await expect(accept(data, registry)).rejects.toThrow(/schema rejected|canonical/i);
	});

	test("rejects every manifest signed by a revoked key, including pre-revocation publications", async () => {
		const data = await fixture();
		const key = data.trustedKeys.get("test-key")!;
		key.revokedAt = "2027-01-01T00:00:00.000Z";
		await expect(accept(data, signedRegistry(data.privateKey, 1))).rejects.toThrow(/revoked/i);
	});

	test("recovers from a revoked cached generation through a newer trusted key", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 });
		data.trustedKeys.get("test-key")!.revokedAt = "2027-01-01T00:00:00.000Z";
		const rotated = crypto.generateKeyPairSync("ed25519");
		data.trustedKeys.set("rotated-key", {
			keyId: "rotated-key",
			publicKeyPem: rotated.publicKey.export({ type: "spki", format: "pem" }).toString(),
			validFrom: "2026-01-01T00:00:00.000Z",
		});
		await expect(
			accept(data, signedRegistry(rotated.privateKey, 2, undefined, undefined, undefined, undefined, "rotated-key")),
		).resolves.toMatchObject({ status: "updated", revision: 2 });
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(2);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir }).pinnedRevision).toBeUndefined();
	});

	test("rejects pinning a retained revoked generation", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		data.trustedKeys.get("test-key")!.revokedAt = "2027-01-01T00:00:00.000Z";
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.history[0].revoked = true;
		await Bun.write(statePath, JSON.stringify(state));

		await expect(setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 })).rejects.toThrow(/revoked/i);
	});

	test("unpinning revoked-only history leaves no active revision", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 });
		data.trustedKeys.get("test-key")!.revokedAt = "2027-01-01T00:00:00.000Z";
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.history[0].revoked = true;
		state.activeRevision = undefined;
		await Bun.write(statePath, JSON.stringify(state));
		const controlPath = path.join(data.agentDir, "model-presets", "control.json");
		const control = await Bun.file(controlPath).json();
		control.pinnedRevision = 1;
		await Bun.write(controlPath, JSON.stringify(control));

		await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: undefined });
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir }).activeRevision).toBeUndefined();
	});

	test("preserves the anti-rollback floor when the highest cached generation is revoked", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		data.trustedKeys.get("test-key")!.revokedAt = "2027-01-01T00:00:00.000Z";
		const rotated = crypto.generateKeyPairSync("ed25519");
		data.trustedKeys.set("rotated-key", {
			keyId: "rotated-key",
			publicKeyPem: rotated.publicKey.export({ type: "spki", format: "pem" }).toString(),
			validFrom: "2026-01-01T00:00:00.000Z",
		});
		await expect(
			accept(data, signedRegistry(rotated.privateKey, 1, undefined, undefined, undefined, undefined, "rotated-key")),
		).rejects.toThrow(/equivocation|downgrade/i);
		const state = await Bun.file(path.join(data.agentDir, "model-presets", "state.json")).json();
		expect(state.highestSeenRevision).toBe(1);
		expect(state.history).toHaveLength(1);
		expect(state.history[0].revoked).toBe(true);
	});

	test("keeps a newer rotated generation available during offline startup", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		const rotated = crypto.generateKeyPairSync("ed25519");
		data.trustedKeys.set("rotated-key", {
			keyId: "rotated-key",
			publicKeyPem: rotated.publicKey.export({ type: "spki", format: "pem" }).toString(),
			validFrom: "2026-01-01T00:00:00.000Z",
		});
		await accept(
			data,
			signedRegistry(rotated.privateKey, 2, undefined, undefined, undefined, undefined, "rotated-key"),
		);
		data.trustedKeys.get("test-key")!.revokedAt = "2027-01-01T00:00:00.000Z";
		const accepted = loadAcceptedModelPresetRegistry(data.agentDir, {});
		expect(accepted.revision).toBe(2);
		expect(accepted.profiles.has("remote")).toBe(true);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			cacheHealth: "valid",
			activeRevision: 2,
			highestSeenRevision: 2,
		});
	});

	test("keeps retained selections available after offline rotation recovery", async () => {
		const data = await fixture();
		await accept(
			data,
			signedRegistry(
				data.privateKey,
				1,
				[registryProfile("retained", "provider/retained-model")],
				[registryPreset("retained-model")],
			),
		);
		const rotated = crypto.generateKeyPairSync("ed25519");
		data.trustedKeys.set("rotated-key", {
			keyId: "rotated-key",
			publicKeyPem: rotated.publicKey.export({ type: "spki", format: "pem" }).toString(),
			validFrom: "2026-01-01T00:00:00.000Z",
		});
		await accept(
			data,
			signedRegistry(
				rotated.privateKey,
				2,
				[registryProfile("replacement", "provider/replacement-model")],
				[registryPreset("replacement-model")],
				undefined,
				[],
				"rotated-key",
			),
		);
		data.trustedKeys.get("test-key")!.revokedAt = "2027-01-01T00:00:00.000Z";
		const accepted = loadAcceptedModelPresetRegistry(data.agentDir, {});
		expect(accepted.revision).toBe(2);
		expect(accepted.profiles.has("retained")).toBe(true);
		expect(accepted.presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "retained-model" })]));
	});

	test("recovers rotated cache before handling a 304 response", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		const rotated = crypto.generateKeyPairSync("ed25519");
		data.trustedKeys.set("rotated-key", {
			keyId: "rotated-key",
			publicKeyPem: rotated.publicKey.export({ type: "spki", format: "pem" }).toString(),
			validFrom: "2026-01-01T00:00:00.000Z",
		});
		await accept(
			data,
			signedRegistry(rotated.privateKey, 2, undefined, undefined, undefined, undefined, "rotated-key"),
		);
		data.trustedKeys.get("test-key")!.revokedAt = "2027-01-01T00:00:00.000Z";
		const fetch304 = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
		await expect(
			accept(
				data,
				signedRegistry(rotated.privateKey, 2, undefined, undefined, undefined, undefined, "rotated-key"),
				fetch304,
			),
		).resolves.toMatchObject({ status: "not_modified", revision: 2 });
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(2);
	});
	test("uses ETag 304 only with a verified warm cache", async () => {
		const data = await fixture();
		const registry = signedRegistry(data.privateKey, 1);
		await accept(data, registry);
		let ifNoneMatch: string | null = null;
		const fetch304 = (async (_input, init) => {
			ifNoneMatch = new Headers(init?.headers).get("if-none-match");
			const statePath = path.join(data.agentDir, "model-presets", "state.json");
			const externallyUpdated = await Bun.file(statePath).json();
			externallyUpdated.externalWriterMarker = "preserve-me";
			await Bun.write(statePath, JSON.stringify(externallyUpdated));
			return new Response(null, { status: 304 });
		}) as typeof fetch;
		expect(await accept(data, registry, fetch304)).toEqual({ status: "not_modified", revision: 1 });
		expect(ifNoneMatch as string | null).toBe('"revision"');
		expect(
			(await Bun.file(path.join(data.agentDir, "model-presets", "state.json")).json()).externalWriterMarker,
		).toBe("preserve-me");
		const externalAgentDir = await createTrackedDirectory("gjc-preset-registry-external-");
		const externalRun = <T>(operation: () => T): T =>
			withModelPresetRegistryTestTrust(externalAgentDir, data.trustedKeys, operation);
		testTrustRunners.set(externalAgentDir, externalRun);
		const externalData: RegistryFixture = { ...data, agentDir: externalAgentDir, run: externalRun };
		await accept(externalData, signedRegistry(data.privateKey, 2));
		const externalState = await Bun.file(path.join(externalAgentDir, "model-presets", "state.json")).text();
		await Bun.write(path.join(data.agentDir, "model-presets", "state.json"), externalState);
		await expect(
			data.run(() =>
				refreshModelPresetRegistryImpl({
					agentDir: data.agentDir,
					manifestUrl,
					knownManifestSha256: sha256(registry.manifestBody),
					fetch: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
				}),
			),
		).resolves.toMatchObject({ status: "updated", revision: 2 });
	});

	test("does not reuse an ETag across manifest paths on the same origin", async () => {
		const data = await fixture();
		const registry = signedRegistry(data.privateKey, 1);
		const firstUrl = "https://registry.example.test/one/latest.json";
		const secondUrl = "https://registry.example.test/two/latest.json";
		await expect(
			data.run(() =>
				refreshModelPresetRegistryImpl({
					agentDir: data.agentDir,
					manifestUrl: firstUrl,
					fetch: registryFetch(registry),
				}),
			),
		).resolves.toMatchObject({ status: "updated", revision: 1 });
		let observedIfNoneMatch: string | null = null;
		const secondFetch = (async (_input, init) => {
			observedIfNoneMatch = new Headers(init?.headers).get("if-none-match");
			return new Response(registry.manifestBody);
		}) as typeof fetch;
		await expect(
			data.run(() =>
				refreshModelPresetRegistryImpl({
					agentDir: data.agentDir,
					manifestUrl: secondUrl,
					fetch: secondFetch,
				}),
			),
		).rejects.toThrow(/snapshot|request failed|schema/i);
		expect(observedIfNoneMatch).toBeNull();
	});

	test.skipIf(process.platform !== "win32")("replaces existing registry state repeatedly on Windows", async () => {
		const data = await fixture();
		for (let revision = 1; revision <= 5; revision++) await accept(data, signedRegistry(data.privateKey, revision));
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(5);
	});

	test("rejects duplicate accepted revisions before selection", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.history.push(structuredClone(state.history[0]));
		await Bun.write(statePath, JSON.stringify(state));
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).profiles.size).toBe(0);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({ cacheHealth: "corrupt" });
		await expect(setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 })).rejects.toThrow(
			/duplicate revision/i,
		);
	});

	test("does not report a valid selected generation when another history row is corrupt", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await accept(data, signedRegistry(data.privateKey, 2));
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.history[1].retainedProfiles = [registryProfile("corrupt-unrelated", "https://evil.example/model")];
		await Bun.write(statePath, JSON.stringify(state));

		const status = getModelPresetRegistryStatus({ agentDir: data.agentDir });
		expect(status).toMatchObject({
			source: "embedded",
			cacheHealth: "corrupt",
			profileCount: 0,
			presetCount: 0,
			historyRevisions: [],
		});
		expect(status.activeRevision).toBeUndefined();
		expect(status.highestSeenRevision).toBeUndefined();
	});

	test("ignores an unbound anti-rollback floor and keeps a verified recovery checkpoint", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 });
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.highestSeenRevision = 99_999_999;
		state.highestSeenManifestSha256 = "f".repeat(64);
		await Bun.write(statePath, JSON.stringify(state));
		await expect(accept(data, signedRegistry(data.privateKey, 2))).resolves.toMatchObject({
			status: "updated",
			revision: 2,
		});
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(2);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			highestSeenRevision: 2,
			pinnedRevision: undefined,
		});
	});

	test("preserves an unbound checkpoint when refresh fails after state corruption", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.highestSeenRevision = 99_999_999;
		state.highestSeenManifestSha256 = "f".repeat(64);
		await Bun.write(statePath, JSON.stringify(state));
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				fetch: (async () => {
					throw new Error("offline");
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow("Registry refresh failed.");
		const recoveredState = await Bun.file(statePath).json();
		expect(recoveredState.highestSeenRevision).toBe(99_999_999);
		expect(recoveredState.highestSeenManifestSha256).toBe("f".repeat(64));
	});

	test("preserves an unbound anti-rollback floor when failed recovery has no history", async () => {
		const data = await fixture();
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		await Bun.write(
			statePath,
			JSON.stringify({
				version: 1,
				history: [],
				highestSeenRevision: 99,
				highestSeenManifestSha256: "f".repeat(64),
			}),
		);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				fetch: (async () => {
					throw new Error("offline");
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow(/anti-rollback checkpoint cannot be reconstructed/i);
		const recoveredState = await Bun.file(statePath).json();
		expect(recoveredState.highestSeenRevision).toBe(99);
		expect(recoveredState.highestSeenManifestSha256).toBe("f".repeat(64));
		expect(recoveredState.history).toEqual([]);
	});

	test("recovers the backup floor when the primary state is missing", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await accept(data, signedRegistry(data.privateKey, 2));
		await fs.rm(path.join(data.agentDir, "model-presets", "state.json"));
		await expect(accept(data, signedRegistry(data.privateKey, 1))).rejects.toThrow(/downgrade/i);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			activeRevision: 2,
			highestSeenRevision: 2,
		});
	});

	test("recovers the backup floor when the primary state is reset-shaped", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await accept(data, signedRegistry(data.privateKey, 2));
		await Bun.write(path.join(data.agentDir, "model-presets", "state.json"), '{"version":1,"history":[]}');
		await expect(accept(data, signedRegistry(data.privateKey, 1))).rejects.toThrow(/downgrade/i);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			activeRevision: 2,
			highestSeenRevision: 2,
		});
	});

	test("keeps a rollback active intent while taking the maximum floor from a stale backup", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await accept(data, signedRegistry(data.privateKey, 2));
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const staleBackup = await Bun.file(statePath).json();
		await rollbackModelPresetRegistry({ agentDir: data.agentDir, revision: 1 });
		await Bun.write(path.join(data.agentDir, "model-presets", "state.backup.json"), JSON.stringify(staleBackup));
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			activeRevision: 1,
			highestSeenRevision: 2,
		});
		await expect(accept(data, signedRegistry(data.privateKey, 1))).rejects.toThrow(/downgrade/i);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir }).activeRevision).toBe(1);
	});

	test("uses a clean backup floor when the primary highest generation is corrupt", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await accept(data, signedRegistry(data.privateKey, 2));
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.history[0].retainedProfiles = [registryProfile("corrupt", "https://evil.example/model")];
		await Bun.write(statePath, JSON.stringify(state));
		await expect(accept(data, signedRegistry(data.privateKey, 1))).rejects.toThrow(/downgrade/i);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			cacheHealth: "valid",
			activeRevision: 2,
			highestSeenRevision: 2,
		});
	});

	test("records a first refresh failure without creating an empty anti-rollback checkpoint", async () => {
		const data = await fixture();
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				fetch: (async () => {
					throw new Error("offline");
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow("Registry refresh failed.");
		expect(await Bun.file(path.join(data.agentDir, "model-presets", "state.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(data.agentDir, "model-presets", "state.backup.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(data.agentDir, "model-presets", "failure.json")).json()).toMatchObject({
			version: 1,
			lastError: "Registry refresh failed.",
		});
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			cacheHealth: "empty",
			lastError: "Registry refresh failed.",
		});
	});

	test("rejects same-revision equivocation after recovering a verified checkpoint", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.highestSeenRevision = 99_999_999;
		state.highestSeenManifestSha256 = "f".repeat(64);
		await Bun.write(statePath, JSON.stringify(state));
		await expect(accept(data, signedRegistry(data.privateKey, 1, [registryProfile("equivocated")]))).rejects.toThrow(
			/equivocation/i,
		);
	});

	test("falls back cold, remains usable offline warm, and rejects cache corruption without secret leakage", async () => {
		const data = await fixture();
		expect(loadAcceptedModelPresetRegistry(data.agentDir).profiles.size).toBe(0);
		await accept(data, signedRegistry(data.privateKey, 1, [registryProfile("stable")]));
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).profiles.has("stable")).toBe(true);
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.history[0].retainedProfiles = [registryProfile("retained-unsafe", "https://evil.example/model")];
		await Bun.write(statePath, JSON.stringify(state));
		const unsafeRetained = loadAcceptedModelPresetRegistry(data.agentDir, {});
		expect(unsafeRetained.profiles.size).toBe(0);
		expect(unsafeRetained.error).toMatch(/unsafe URL/i);
		await expect(setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 })).rejects.toThrow(/unsafe URL/i);
		await fs.writeFile(path.join(data.agentDir, "model-presets", "state.json"), '{"secret":"DO-NOT-LOG"}');
		const corrupted = loadAcceptedModelPresetRegistry(data.agentDir, {});
		expect(corrupted.profiles.size).toBe(0);
		expect(corrupted.error).not.toContain("DO-NOT-LOG");
	});

	test("sanitizes tampered cached error text before exposing registry status", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.lastError = `Registry refresh failed: ${"x".repeat(2_000)}\u0000\u000b`;
		await Bun.write(statePath, JSON.stringify(state));

		const status = getModelPresetRegistryStatus({ agentDir: data.agentDir });
		expect(status.lastError).toBeDefined();
		expect(status.lastError).not.toMatch(/[\p{Cc}\p{Cf}]/u);
		expect(Buffer.byteLength(status.lastError ?? "", "utf8")).toBeLessThanOrEqual(1024);
	});

	test("clears a pin when failed refresh replaces unreadable state", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 });
		await Bun.write(path.join(data.agentDir, "model-presets", "state.json"), "{");
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				fetch: (async () => {
					throw new Error("offline");
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow("Registry refresh failed.");
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir }).pinnedRevision).toBeUndefined();
		await accept(data, signedRegistry(data.privateKey, 2));
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(2);
	});

	test("single-flights concurrent refresh and retains disappeared profiles and presets", async () => {
		const data = await fixture();
		await accept(
			data,
			signedRegistry(
				data.privateKey,
				1,
				[
					registryProfile("retained", "provider/retained-model"),
					registryProfile("retained-dynamic", "dynamic-provider/future-model"),
					registryProfile("changed", "provider/old-changed-model"),
				],
				[registryPreset("retained-model"), registryPreset("old-changed-model")],
				undefined,
				["dynamic-provider"],
			),
		);
		const second = signedRegistry(
			data.privateKey,
			2,
			[
				registryProfile("replacement", "provider/replacement-model"),
				registryProfile("changed", "provider/new-changed-model"),
			],
			[registryPreset("replacement-model"), registryPreset("new-changed-model")],
		);
		let calls = 0;
		const responses = [second.manifestBody, second.snapshotBody, second.profilesBody, second.presetsBody];
		const fetchImpl = (async () => {
			const body = responses[calls++]!;
			await Bun.sleep(5);
			return new Response(body, calls === 1 ? { headers: { etag: '"two"' } } : undefined);
		}) as unknown as typeof fetch;
		await Promise.all([accept(data, second, fetchImpl), accept(data, second, fetchImpl)]);
		expect(calls).toBe(4);
		const accepted = loadAcceptedModelPresetRegistry(data.agentDir, {});
		expect(accepted.profiles.has("retained")).toBe(true);
		expect(accepted.profiles.has("retained-dynamic")).toBe(true);
		expect(accepted.presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "retained-model" })]));
		expect(accepted.presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "old-changed-model" })]));
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir }).cacheHealth).toBe("valid");
		await accept(
			data,
			signedRegistry(
				data.privateKey,
				3,
				[
					registryProfile("replacement", "provider/replacement-model"),
					registryProfile("changed", "provider/newest-changed-model"),
				],
				[registryPreset("replacement-model"), registryPreset("newest-changed-model")],
			),
		);
		const third = loadAcceptedModelPresetRegistry(data.agentDir, {});
		expect(third.presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "old-changed-model" })]));
		expect(third.presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "new-changed-model" })]));
		const state = await Bun.file(path.join(data.agentDir, "model-presets", "state.json")).json();
		expect(state.history[0].retainedDynamicProviders).toEqual(["dynamic-provider"]);
		state.history[0].retainedProfiles[0].displayName = "Safe-shaped cache injection";
		await Bun.write(path.join(data.agentDir, "model-presets", "state.json"), JSON.stringify(state));
		const tampered = loadAcceptedModelPresetRegistry(data.agentDir, {});
		expect(tampered.profiles.size).toBe(0);
		expect(tampered.error).toMatch(/retained provenance content/i);
		await expect(accept(data, signedRegistry(data.privateKey, 4))).resolves.toMatchObject({
			status: "updated",
			revision: 4,
		});
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(4);
	});

	test("does not coalesce refreshes with different request dependencies", async () => {
		const data = await fixture();
		const first = signedRegistry(data.privateKey, 1);
		const second = signedRegistry(data.privateKey, 2);
		let firstCalls = 0;
		let secondCalls = 0;
		const firstHeaders: Headers[] = [];
		const secondHeaders: Headers[] = [];
		const firstFetchBase = registryFetch(first, firstHeaders);
		const secondFetchBase = registryFetch(second, secondHeaders);
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const firstFetch = (async (input, init) => {
			firstCalls++;
			if (firstCalls === 1) {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			return firstFetchBase(input, init);
		}) as typeof fetch;
		const secondFetch = (async (input, init) => {
			secondCalls++;
			return secondFetchBase(input, init);
		}) as typeof fetch;
		const firstRefresh = data.run(() =>
			refreshModelPresetRegistryImpl({
				agentDir: data.agentDir,
				manifestUrl: "https://first.registry.example/latest.json",
				fetch: firstFetch,
			}),
		);
		await firstEntered.promise;
		const secondRefresh = data.run(() =>
			refreshModelPresetRegistryImpl({
				agentDir: data.agentDir,
				manifestUrl: "https://second.registry.example/latest.json",
				fetch: secondFetch,
			}),
		);
		releaseFirst.resolve();
		await expect(firstRefresh).resolves.toMatchObject({ revision: 1 });
		await expect(secondRefresh).resolves.toMatchObject({ revision: 2 });
		expect(firstCalls).toBe(4);
		expect(secondCalls).toBe(4);
		expect(firstHeaders[0]?.get("if-none-match")).toBeNull();
		expect(secondHeaders[0]?.get("if-none-match")).toBeNull();
	});

	test("never awaits startup network and publishes a later accepted catalog to the live registry", async () => {
		const data = await fixture();
		const remote = signedRegistry(data.privateKey, 1, [registryProfile("background-profile")]);
		await Bun.write(
			path.join(data.agentDir, "models.yml"),
			`providers:
  provider:
    baseUrl: https://provider.example/v1
    api: openai-completions
    auth: none
`,
		);
		let calls = 0;
		const fetchImpl = registryFetch(remote);
		const countingFetch = (async (input, init) => {
			calls++;
			if (calls > 4) return new Response(null, { status: 304 });
			return fetchImpl(input, init);
		}) as typeof fetch;
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "background-auth.db"));
		let modelRegistry: ModelRegistry | undefined;
		try {
			modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						manifestUrl,
						fetch: countingFetch,
						startupDelayMs: 20,
						refreshIntervalMs: 30,
					}),
			);
			const catalogChanged = vi.fn();
			modelRegistry.onCatalogChanged(catalogChanged);
			expect(calls).toBe(0);
			expect(modelRegistry.getModelProfile("background-profile")).toBeUndefined();
			for (let attempt = 0; attempt < 50 && !modelRegistry.getModelProfile("background-profile"); attempt++)
				await Bun.sleep(10);
			expect(calls).toBe(4);
			expect(modelRegistry.getModelProfile("background-profile")?.source).toBe("registry");
			const publicationsAfterAcceptance = catalogChanged.mock.calls.length;
			for (let attempt = 0; attempt < 20 && calls < 5; attempt++) await Bun.sleep(10);
			expect(calls).toBeGreaterThanOrEqual(5);
			expect(catalogChanged).toHaveBeenCalledTimes(publicationsAfterAcceptance);
			await setModelPresetRegistryDisabled({ agentDir: data.agentDir, disabled: true });
			for (let attempt = 0; attempt < 20 && modelRegistry.getModelProfile("background-profile"); attempt++)
				await Bun.sleep(10);
			expect(modelRegistry.getModelProfile("background-profile")).toBeUndefined();
			await setModelPresetRegistryDisabled({ agentDir: data.agentDir, disabled: false });
			for (let attempt = 0; attempt < 20 && !modelRegistry.getModelProfile("background-profile"); attempt++)
				await Bun.sleep(10);
			expect(modelRegistry.getModelProfile("background-profile")?.source).toBe("registry");
			const callsBeforeDispose = calls;
			modelRegistry.dispose();
			await Bun.sleep(100);
			expect(calls).toBeLessThanOrEqual(callsBeforeDispose + 1);
			const callsAfterDispose = calls;
			await Bun.sleep(100);
			expect(calls).toBe(callsAfterDispose);
		} finally {
			modelRegistry?.dispose();
			authStorage.close();
		}
	});

	test("publishes offline pin and malformed-cache disable changes to live consumers", async () => {
		const data = await fixture();
		await accept(
			data,
			signedRegistry(
				data.privateKey,
				1,
				[registryProfile("selected", "provider/model-1")],
				[registryPreset("model-1")],
			),
		);
		await accept(
			data,
			signedRegistry(
				data.privateKey,
				2,
				[registryProfile("selected", "provider/model-2")],
				[registryPreset("model-2")],
			),
		);
		await Bun.write(
			path.join(data.agentDir, "models.yml"),
			`providers:
  provider:
    baseUrl: https://provider.example/v1
    api: openai-completions
    auth: none
`,
		);
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "offline-controls-auth.db"));
		const modelRegistry = data.run(
			() =>
				new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
					manifestUrl,
					startupDelayMs: 20,
					refreshIntervalMs: 30,
					fetch: (async () => {
						throw new Error("offline");
					}) as unknown as typeof fetch,
				}),
		);
		try {
			expect(modelRegistry.getModelProfile("selected")?.modelMapping.default).toBe("provider/model-2");
			await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 });
			for (
				let attempt = 0;
				attempt < 20 && modelRegistry.getModelProfile("selected")?.modelMapping.default !== "provider/model-1";
				attempt++
			)
				await Bun.sleep(10);
			expect(modelRegistry.getModelProfile("selected")?.modelMapping.default).toBe("provider/model-1");
			await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: undefined });
			for (
				let attempt = 0;
				attempt < 20 && modelRegistry.getModelProfile("selected")?.modelMapping.default !== "provider/model-2";
				attempt++
			)
				await Bun.sleep(10);
			expect(modelRegistry.getModelProfile("selected")?.modelMapping.default).toBe("provider/model-2");
			await Bun.write(path.join(data.agentDir, "model-presets", "state.json"), "{");
			await setModelPresetRegistryDisabled({ agentDir: data.agentDir, disabled: true });
			for (let attempt = 0; attempt < 20 && modelRegistry.getModelProfile("selected"); attempt++)
				await Bun.sleep(10);
			expect(modelRegistry.getModelProfile("selected")).toBeUndefined();
		} finally {
			modelRegistry.dispose();
			authStorage.close();
		}
	});

	test("proves cold startup through signed activation, rollback, pinning, unpinning, and cached restart selection", async () => {
		const data = await fixture();
		const revisionOne = signedRegistry(
			data.privateKey,
			1,
			[registryProfile("selected", "provider/model-1")],
			[registryPreset("model-1", 8_192)],
		);
		const revisionTwo = signedRegistry(
			data.privateKey,
			2,
			[registryProfile("selected", "provider/model-2")],
			[registryPreset("model-2", 16_384)],
		);
		const modelsPath = path.join(data.agentDir, "models.yml");
		await Bun.write(
			modelsPath,
			`providers:
  provider:
    baseUrl: https://provider.example/v1
    api: openai-completions
    auth: none
`,
		);

		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			cacheHealth: "empty",
			activeRevision: undefined,
			highestSeenRevision: undefined,
		});

		let authStorage: AuthStorage | undefined;
		let modelRegistry: ModelRegistry | undefined;
		let restartedAuthStorage: AuthStorage | undefined;
		let restartedRegistry: ModelRegistry | undefined;
		const reload = async (registry: ModelRegistry): Promise<void> => {
			await data.run(() => registry.refresh("offline"));
		};
		const expectSelection = (registry: ModelRegistry, modelId: string, contextWindow: number): void => {
			expect(registry.getModelProfile("selected")).toMatchObject({
				source: "registry",
				modelMapping: { default: `provider/${modelId}` },
			});
			expect(registry.find("provider", modelId)).toMatchObject({
				provider: "provider",
				id: modelId,
				contextWindow,
			});
		};
		try {
			authStorage = await AuthStorage.create(path.join(data.agentDir, "lifecycle-auth.db"));
			modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage!, modelsPath, undefined, {
						agentDir: data.agentDir,
						automaticRefresh: false,
					}),
			);
			expect(modelRegistry.getModelProfile("selected")).toBeUndefined();
			expect(modelRegistry.find("provider", "model-1")).toBeUndefined();

			await expect(accept(data, revisionOne)).resolves.toMatchObject({ status: "updated", revision: 1 });
			await reload(modelRegistry);
			expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
				cacheHealth: "valid",
				activeRevision: 1,
				highestSeenRevision: 1,
			});
			expectSelection(modelRegistry, "model-1", 8_192);

			await expect(accept(data, revisionTwo)).resolves.toMatchObject({ status: "updated", revision: 2 });
			await reload(modelRegistry);
			expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
				activeRevision: 2,
				highestSeenRevision: 2,
			});
			expectSelection(modelRegistry, "model-2", 16_384);

			await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 });
			await reload(modelRegistry);
			expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
				activeRevision: 1,
				pinnedRevision: 1,
				highestSeenRevision: 2,
			});
			expectSelection(modelRegistry, "model-1", 8_192);

			await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: undefined });
			await reload(modelRegistry);
			expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
				activeRevision: 2,
				pinnedRevision: undefined,
				highestSeenRevision: 2,
			});
			expectSelection(modelRegistry, "model-2", 16_384);

			await rollbackModelPresetRegistry({ agentDir: data.agentDir, revision: 1 });
			await reload(modelRegistry);
			expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
				activeRevision: 1,
				pinnedRevision: undefined,
				highestSeenRevision: 2,
			});
			expectSelection(modelRegistry, "model-1", 8_192);

			await modelRegistry.dispose();
			modelRegistry = undefined;
			authStorage.close();
			authStorage = undefined;
			restartedAuthStorage = await AuthStorage.create(path.join(data.agentDir, "lifecycle-restart-auth.db"));
			restartedRegistry = data.run(
				() =>
					new ModelRegistry(restartedAuthStorage!, modelsPath, undefined, {
						agentDir: data.agentDir,
						automaticRefresh: false,
					}),
			);
			expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
				activeRevision: 1,
				highestSeenRevision: 2,
			});
			expectSelection(restartedRegistry, "model-1", 8_192);
		} finally {
			if (restartedRegistry) await restartedRegistry.dispose();
			restartedAuthStorage?.close();
			if (modelRegistry) await modelRegistry.dispose();
			authStorage?.close();
		}
	});

	test("publishes local controls without waiting for the refresh interval", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await accept(data, signedRegistry(data.privateKey, 2));
		const onAccepted = vi.fn();
		const dispose = refreshModelPresetRegistryInBackground(
			{
				agentDir: data.agentDir,
				automaticRefresh: true,
				startupDelayMs: 60_000,
				refreshIntervalMs: 60_000,
				fetch: (async () => {
					throw new Error("offline");
				}) as unknown as typeof fetch,
			},
			onAccepted,
		);
		try {
			await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 });
			for (let attempt = 0; attempt < 20 && onAccepted.mock.calls.length < 1; attempt++) await Bun.sleep(1);
			expect(onAccepted).toHaveBeenCalledTimes(1);
			await setModelPresetRegistryPin({ agentDir: data.agentDir });
			for (let attempt = 0; attempt < 20 && onAccepted.mock.calls.length < 2; attempt++) await Bun.sleep(1);
			expect(onAccepted).toHaveBeenCalledTimes(2);
		} finally {
			dispose();
		}
	});

	test("does not publish an in-flight refresh callback after registry disposal", async () => {
		const data = await fixture();
		const remote = signedRegistry(data.privateKey, 1, [registryProfile("late-profile")]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const responses = [remote.manifestBody, remote.snapshotBody, remote.profilesBody, remote.presetsBody];
		const fetchImpl = (async () => {
			if (calls === 0) {
				entered.resolve();
				await release.promise;
			}
			return new Response(responses[calls++]!);
		}) as unknown as typeof fetch;
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "disposed-refresh-auth.db"));
		const modelRegistry = data.run(
			() =>
				new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
					manifestUrl,
					fetch: fetchImpl,
					startupDelayMs: 0,
					refreshIntervalMs: 30,
				}),
		);
		const catalogChanged = vi.fn();
		modelRegistry.onCatalogChanged(catalogChanged);
		try {
			await entered.promise;
			const disposal = modelRegistry.dispose();
			release.resolve();
			await disposal;
			expect(calls).toBe(4);
			expect(modelRegistry.getModelProfile("late-profile")).toBeUndefined();
			await modelRegistry.refresh("offline");
			expect(catalogChanged).not.toHaveBeenCalled();
		} finally {
			modelRegistry.dispose();
			authStorage.close();
		}
	});

	test("awaits a deferred refresh before allowing its fixture root to be removed", async () => {
		const data = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fetchImpl = (async () => {
			entered.resolve();
			await release.promise;
			throw new Error("offline");
		}) as unknown as typeof fetch;
		const dispose = refreshModelPresetRegistryInBackground({
			agentDir: data.agentDir,
			manifestUrl,
			startupDelayMs: 0,
			refreshIntervalMs: 60_000,
			fetch: fetchImpl,
		});
		await entered.promise;
		const disposal = dispose();
		let settled = false;
		void disposal.then(() => {
			settled = true;
		});
		await Bun.sleep(10);
		expect(settled).toBe(false);
		await fs.rm(data.agentDir, { recursive: true, force: true });
		release.resolve();
		await disposal;
		expect(
			await fs
				.stat(data.agentDir)
				.then(() => true)
				.catch(() => false),
		).toBe(false);
	});

	test("releases the auth-generation listener when a registry is disposed", async () => {
		const data = await fixture();
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "listener-auth.db"));
		const unsubscribe = vi.fn();
		const listenerSpy = vi.spyOn(authStorage, "onGenerationChanged").mockReturnValue(unsubscribe);
		try {
			const modelRegistry = data.run(
				() =>
					new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
						automaticRefresh: false,
					}),
			);
			modelRegistry.dispose();
			modelRegistry.dispose();
			expect(unsubscribe).toHaveBeenCalledTimes(1);
		} finally {
			listenerSpy.mockRestore();
			authStorage.close();
		}
	});

	test("synchronously reloads the catalog when scoped settings are installed", async () => {
		const data = await fixture();
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "scoped-settings-auth.db"));
		const modelRegistry = data.run(
			() =>
				new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
					automaticRefresh: false,
				}),
		);
		const scopedSettings = Settings.isolated({ disabledProviders: ["ollama"] });
		try {
			expect(modelRegistry.getDiscoverableProviders()).toContain("ollama");
			modelRegistry.setScopedSettings(scopedSettings);
			expect(modelRegistry.getDiscoverableProviders()).not.toContain("ollama");
			scopedSettings.override("disabledProviders", []);
			modelRegistry.setScopedSettings(scopedSettings);
			expect(modelRegistry.getDiscoverableProviders()).toContain("ollama");
		} finally {
			modelRegistry.dispose();
			authStorage.close();
		}
	});

	test("prevents an in-flight refresh from overwriting replaced scoped settings", async () => {
		const data = await fixture();
		await Bun.write(
			path.join(data.agentDir, "models.yml"),
			`providers:
  scoped-provider:
    baseUrl: https://scoped.example/v1
    api: openai-completions
    auth: none
    discovery:
      type: openai-models-list
`,
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			if (String(input) !== "https://scoped.example/v1/models") throw new Error(`Unexpected URL: ${input}`);
			entered.resolve();
			await release.promise;
			return new Response(JSON.stringify({ data: [{ id: "stale-scoped-model" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch);
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "scoped-refresh-auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
			automaticRefresh: false,
		});
		try {
			const refresh = modelRegistry.refreshProvider("scoped-provider", "online");
			await entered.promise;
			modelRegistry.setScopedSettings(Settings.isolated({ disabledProviders: ["scoped-provider"] }));
			release.resolve();
			await refresh;
			expect(modelRegistry.find("scoped-provider", "stale-scoped-model")).toBeUndefined();
			expect(modelRegistry.getDiscoverableProviders()).not.toContain("scoped-provider");
		} finally {
			release.resolve();
			modelRegistry.dispose();
			authStorage.close();
			fetchSpy.mockRestore();
		}
	});

	test("supports rollback, pin, unpin, and disable without lowering highest-seen provenance", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await accept(data, signedRegistry(data.privateKey, 2));
		await rollbackModelPresetRegistry({ agentDir: data.agentDir, revision: 1 });
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			activeRevision: 1,
			highestSeenRevision: 2,
		});
		await accept(data, signedRegistry(data.privateKey, 2));
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir }).activeRevision).toBe(1);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				fetch: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
			}),
		).resolves.toMatchObject({ status: "not_modified", revision: 2 });
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir }).activeRevision).toBe(1);
		await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 2 });
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(2);
		await rollbackModelPresetRegistry({ agentDir: data.agentDir, revision: 1 });
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			activeRevision: 1,
			pinnedRevision: undefined,
		});
		await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 2 });
		await setModelPresetRegistryPin({ agentDir: data.agentDir });
		await setModelPresetRegistryDisabled({ agentDir: data.agentDir, disabled: true });
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {})).toMatchObject({
			disabled: true,
		});
		await setModelPresetRegistryDisabled({ agentDir: data.agentDir, disabled: false });
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir }).highestSeenRevision).toBe(2);
	});

	test("compacts retained provenance before the durable byte budget is exceeded", async () => {
		const data = await fixture();
		const first = signedRegistry(
			data.privateKey,
			1,
			[registryProfile("changing", "provider/model-1")],
			[{ ...registryPreset("model-1"), name: "x".repeat(240) }],
		);
		await accept(data, first);
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const firstBytes = (await fs.stat(statePath)).size;
		const maxStateBytes = firstBytes * 4;
		for (let revision = 2; revision <= 12; revision++) {
			const registry = signedRegistry(
				data.privateKey,
				revision,
				[registryProfile("changing", `provider/model-${revision}`)],
				[{ ...registryPreset(`model-${revision}`), name: "x".repeat(240) }],
			);
			await accept(data, registry, registryFetch(registry), { maxStateBytes });
		}
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(12);
		expect((await fs.stat(statePath)).size).toBeLessThanOrEqual(maxStateBytes);
	});

	test("bounds retained provenance ancestry without replacing the LKG", async () => {
		const data = await fixture();
		for (let revision = 1; revision <= 65; revision++) {
			await accept(
				data,
				signedRegistry(
					data.privateKey,
					revision,
					[registryProfile("changing", `provider/model-${revision}`)],
					[registryPreset(`model-${revision}`)],
				),
			);
		}
		await expect(
			accept(
				data,
				signedRegistry(
					data.privateKey,
					66,
					[registryProfile("changing", "provider/model-66")],
					[registryPreset("model-66")],
				),
			),
		).resolves.toMatchObject({ revision: 66 });
		const accepted = loadAcceptedModelPresetRegistry(data.agentDir, {});
		expect(accepted.revision).toBe(66);
		expect(accepted.presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "model-65" })]));
		expect(accepted.presets.some(preset => preset.id === "model-1")).toBe(false);
		const state = await Bun.file(path.join(data.agentDir, "model-presets", "state.json")).json();
		expect(state.history.length).toBeLessThanOrEqual(4);
	});

	test("never evicts a selected pinned generation when bounded history advances", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 });
		for (let revision = 2; revision <= 5; revision++) await accept(data, signedRegistry(data.privateKey, revision));
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(1);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir }).historyRevisions).toEqual([5, 4, 3, 2, 1]);
	});

	test("serializes a concurrent pin against refresh history pruning", async () => {
		const data = await fixture();
		for (let revision = 1; revision <= 4; revision++) await accept(data, signedRegistry(data.privateKey, revision));
		const fifth = signedRegistry(data.privateKey, 5);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const responses = [fifth.manifestBody, fifth.snapshotBody, fifth.profilesBody, fifth.presetsBody];
		const fetchImpl = (async () => {
			if (calls === 0) {
				entered.resolve();
				await release.promise;
			}
			return new Response(responses[calls++]!);
		}) as unknown as typeof fetch;
		const refresh = refreshModelPresetRegistry({
			agentDir: data.agentDir,
			manifestUrl,
			fetch: fetchImpl,
		});
		await entered.promise;
		const pin = setModelPresetRegistryPin({
			agentDir: data.agentDir,
			revision: 1,
		});
		await Bun.sleep(20);
		release.resolve();
		await expect(refresh).resolves.toMatchObject({ status: "updated", revision: 5 });
		await expect(pin).rejects.toThrow(/Cannot pin unaccepted registry revision 1/);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir })).toMatchObject({
			cacheHealth: "valid",
			activeRevision: 5,
		});
	});

	test("rejects an oversized next state without replacing the active LKG", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		const second = signedRegistry(data.privateKey, 2);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				fetch: registryFetch(second),
				maxStateBytes: 100,
			}),
		).rejects.toThrow(/durable size limit/i);
		expect(loadAcceptedModelPresetRegistry(data.agentDir, {}).revision).toBe(1);
	});

	test("counts the durable state trailing newline against the byte budget", async () => {
		const data = await fixture();
		const now = () => new Date("2026-08-26T00:00:00.000Z");
		const first = signedRegistry(data.privateKey, 1);
		await accept(data, first, registryFetch(first), { now });
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const firstState = await Bun.file(statePath).json();
		const second = signedRegistry(data.privateKey, 2);
		await expect(
			accept(data, second, registryFetch(second), { now, maxStateBytes: 10 * 1024 * 1024 }),
		).resolves.toMatchObject({ status: "updated", revision: 2 });
		const secondState = await Bun.file(statePath).json();
		const secondStateBytes = Buffer.byteLength(JSON.stringify(secondState), "utf8");
		await Bun.write(statePath, `${JSON.stringify(firstState)}\n`);
		await expect(
			accept(data, second, registryFetch(second), { now, maxStateBytes: secondStateBytes }),
		).rejects.toThrow(/durable size limit/i);
		await expect(
			accept(data, second, registryFetch(second), { now, maxStateBytes: secondStateBytes + 1 }),
		).resolves.toMatchObject({ status: "updated", revision: 2 });
	});
	test("reuses verification while unchanged without exposing mutable cached contents", async () => {
		const data = await fixture();
		const first = signedRegistry(data.privateKey, 1, [registryProfile("first-profile")]);
		await accept(data, first, registryFetch(first));

		const initial = loadAcceptedModelPresetRegistry(data.agentDir);
		expect(initial.revision).toBe(1);
		expect(initial.profiles.has("first-profile")).toBe(true);
		initial.profiles.clear();
		initial.presets.length = 0;
		expect(loadAcceptedModelPresetRegistry(data.agentDir).profiles.has("first-profile")).toBe(true);
		expect(loadAcceptedModelPresetRegistry(data.agentDir).presets).not.toHaveLength(0);

		const second = signedRegistry(data.privateKey, 2, [registryProfile("second-profile")]);
		await accept(data, second, registryFetch(second));
		const afterRefresh = loadAcceptedModelPresetRegistry(data.agentDir);
		expect(afterRefresh).not.toBe(initial);
		expect(afterRefresh.revision).toBe(2);
		expect(afterRefresh.profiles.has("second-profile")).toBe(true);

		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const tampered = await Bun.file(statePath).json();
		tampered.history[0].profiles.profiles[0].id = "tampered-profile";
		await Bun.write(statePath, JSON.stringify(tampered));
		const afterTamper = loadAcceptedModelPresetRegistry(data.agentDir);
		expect(afterTamper).not.toBe(afterRefresh);
		expect(afterTamper.profiles.has("tampered-profile")).toBe(false);
	});
});
