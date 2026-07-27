import { expect, test } from "bun:test";
import type { ProviderConfigInput } from "../src/config/model-registry";
import { registerTestModelProvider } from "../src/commands/sdk";

const fixtureUrl = new URL("../src/app-server/__tests__/fixtures/stub-model-provider.ts", import.meta.url).href;

test("test model provider requires harness authority and registers its exported models", async () => {
	const registrations: Array<{ name: string; config: ProviderConfigInput }> = [];
	const session = {
		modelRegistry: {
			registerProvider: (name: string, config: ProviderConfigInput) => {
				registrations.push({ name, config });
			},
		},
	};
	await registerTestModelProvider(session, { GJC_TEST_MODEL_PROVIDER: fixtureUrl });
	expect(registrations).toEqual([]);
	await registerTestModelProvider(session, {
		GJC_TEST_MODEL_PROVIDER: fixtureUrl,
		GJC_TEST_MODEL_PROVIDER_AUTHORITY: "1",
	});
	expect(registrations).toHaveLength(1);
	expect(registrations[0]).toMatchObject({
		name: "gjc-app-server-stub",
		config: { api: "gjc-app-server-stub-api", models: [expect.objectContaining({ id: expect.any(String) })] },
	});
});

test("test model provider registration clones nested fixture config before registry mutation", async () => {
	const fixture = (await import(fixtureUrl)) as { models: Array<{ id: string; [key: string]: unknown }> };
	const before = structuredClone(fixture.models);
	await registerTestModelProvider(
		{
			modelRegistry: {
				registerProvider: (_name, config) => {
					const models = config.models!;
					models[0]!.id = "mutated";
					(models[0]! as Record<string, unknown>).nested = { mutated: true };
					models.push({ id: "injected" } as never);
				},
			},
		},
		{ GJC_TEST_MODEL_PROVIDER: fixtureUrl, GJC_TEST_MODEL_PROVIDER_AUTHORITY: "1" },
	);
	expect(fixture.models).toEqual(before);
});

test("authorized test model provider failures block startup", async () => {
	const registrations: unknown[] = [];
	await expect(
		registerTestModelProvider(
			{
				modelRegistry: {
					registerProvider: (...args: [string, ProviderConfigInput]) => {
						registrations.push(args);
					},
				},
			},
			{ GJC_TEST_MODEL_PROVIDER: "file:///missing-gjc-test-provider.mjs", GJC_TEST_MODEL_PROVIDER_AUTHORITY: "1" },
		),
	).rejects.toThrow();
	expect(registrations).toEqual([]);
});

test("unauthorized broken test model provider is ignored", async () => {
	await expect(
		registerTestModelProvider({ modelRegistry: { registerProvider: () => {} } }, {
			GJC_TEST_MODEL_PROVIDER: "file:///missing-gjc-test-provider.mjs",
		}),
	).resolves.toBeUndefined();
});
