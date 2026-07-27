import { beforeEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { clearProviderAuthHealth, getProviderAuthHealth } from "@gajae-code/coding-agent/config/provider-auth-health";
import { OAuthSelectorComponent } from "@gajae-code/coding-agent/modes/components/oauth-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";

let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load red-claw test theme");
	setThemeInstance(testTheme);
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderedText(selector: OAuthSelectorComponent): string {
	installTestTheme();
	return selector.render(240).map(stripAnsi).join("\n");
}

function requireProvider(providerId: string) {
	const provider = getOAuthProviders().find(candidate => candidate.id === providerId);
	if (!provider) throw new Error(`Expected OAuth provider ${providerId}`);
	return provider;
}

async function flushValidation(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

beforeEach(async () => {
	testTheme = await getThemeByName("red-claw");
	installTestTheme();
});

describe("OAuth selector validation generation race", () => {
	test("drops a stale invalid result after the AuthStorage generation changes", async () => {
		const provider = requireProvider("anthropic");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey(provider.id, "initial-key");
		const validation = Promise.withResolvers<boolean>();
		let selector: OAuthSelectorComponent | undefined;

		try {
			const generationBeforeValidation = authStorage.getGeneration();
			selector = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{ validateAuth: async () => validation.promise, requestRender: vi.fn() },
			);
			await Bun.sleep(0);
			expect(renderedText(selector)).toContain("checking");

			authStorage.setRuntimeApiKey(provider.id, "new-generation-key");
			expect(authStorage.getGeneration()).toBeGreaterThan(generationBeforeValidation);
			validation.resolve(false);
			await validation.promise;
			await flushValidation();

			expect(getProviderAuthHealth(authStorage, provider.id)).toBeUndefined();
			expect(renderedText(selector)).not.toContain("checking");
		} finally {
			selector?.dispose();
			clearProviderAuthHealth(authStorage);
			authStorage.close();
		}
	});

	test("records a fresh invalid result when the AuthStorage generation is unchanged", async () => {
		const provider = requireProvider("anthropic");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey(provider.id, "initial-key");
		const validation = Promise.withResolvers<boolean>();
		let selector: OAuthSelectorComponent | undefined;

		try {
			const generationBeforeValidation = authStorage.getGeneration();
			selector = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{ validateAuth: async () => validation.promise, requestRender: vi.fn() },
			);
			await Bun.sleep(0);
			validation.resolve(false);
			await validation.promise;
			await flushValidation();

			expect(authStorage.getGeneration()).toBe(generationBeforeValidation);
			expect(getProviderAuthHealth(authStorage, provider.id)).toBe("invalid");
			expect(renderedText(selector)).toContain("invalid");
		} finally {
			selector?.dispose();
			clearProviderAuthHealth(authStorage);
			authStorage.close();
		}
	});

	test("records a fresh valid result when the AuthStorage generation is unchanged", async () => {
		const provider = requireProvider("anthropic");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey(provider.id, "initial-key");
		const validation = Promise.withResolvers<boolean>();
		let selector: OAuthSelectorComponent | undefined;

		try {
			const generationBeforeValidation = authStorage.getGeneration();
			selector = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{ validateAuth: async () => validation.promise, requestRender: vi.fn() },
			);
			await Bun.sleep(0);
			validation.resolve(true);
			await validation.promise;
			await flushValidation();

			expect(authStorage.getGeneration()).toBe(generationBeforeValidation);
			expect(getProviderAuthHealth(authStorage, provider.id)).toBe("valid");
			expect(renderedText(selector)).not.toContain("checking");
		} finally {
			selector?.dispose();
			clearProviderAuthHealth(authStorage);
			authStorage.close();
		}
	});

	test("terminates the spinner when one provider is stale and another is fresh", async () => {
		const providers = getOAuthProviders().slice(0, 2);
		if (providers.length < 2) throw new Error("Expected at least two OAuth providers");
		const [droppedProvider, freshProvider] = providers;
		if (!droppedProvider || !freshProvider) throw new Error("Expected two OAuth providers");

		const authStorage = await AuthStorage.create(":memory:");
		for (const provider of providers) authStorage.setRuntimeApiKey(provider.id, `${provider.id}-initial-key`);
		const validations = new Map(providers.map(provider => [provider.id, Promise.withResolvers<boolean>()]));
		let selector: OAuthSelectorComponent | undefined;

		try {
			const generationBeforeValidation = authStorage.getGeneration();
			selector = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{
					validateAuth: async providerId => {
						const validation = validations.get(providerId);
						if (!validation) throw new Error(`Unexpected provider validation: ${providerId}`);
						// The first callback runs before the selector starts the second validation,
						// so this mutation gives the two in-flight calls different auth generations.
						if (providerId === droppedProvider.id) {
							authStorage.setRuntimeApiKey(providerId, `${providerId}-new-generation-key`);
						}
						return validation.promise;
					},
					requestRender: vi.fn(),
				},
			);
			await Bun.sleep(0);
			expect(authStorage.getGeneration()).toBeGreaterThan(generationBeforeValidation);
			expect(renderedText(selector)).toContain("checking");

			validations.get(droppedProvider.id)?.resolve(false);
			validations.get(freshProvider.id)?.resolve(true);
			await Promise.all([...validations.values()].map(validation => validation.promise));
			await flushValidation();

			expect(getProviderAuthHealth(authStorage, droppedProvider.id)).toBeUndefined();
			expect(getProviderAuthHealth(authStorage, freshProvider.id)).toBe("valid");
			const rendered = renderedText(selector);
			expect(rendered).not.toContain("checking");
		} finally {
			selector?.dispose();
			clearProviderAuthHealth(authStorage);
			authStorage.close();
		}
	});

	test("keeps the selector-generation guard independent of AuthStorage generation", async () => {
		const provider = requireProvider("anthropic");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey(provider.id, "initial-key");
		const validation = Promise.withResolvers<boolean>();
		let selector: OAuthSelectorComponent | undefined;

		try {
			const generationBeforeValidation = authStorage.getGeneration();
			selector = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{ validateAuth: async () => validation.promise, requestRender: vi.fn() },
			);
			await Bun.sleep(0);
			selector.stopValidation();
			expect(authStorage.getGeneration()).toBe(generationBeforeValidation);
			validation.resolve(false);
			await validation.promise;
			await flushValidation();

			expect(getProviderAuthHealth(authStorage, provider.id)).toBeUndefined();
		} finally {
			selector?.dispose();
			clearProviderAuthHealth(authStorage);
			authStorage.close();
		}
	});
});
