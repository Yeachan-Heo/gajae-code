import { beforeEach, describe, expect, test } from "bun:test";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
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

function type(selector: OAuthSelectorComponent, text: string): void {
	for (const char of text) selector.handleInput(char);
}

async function createSelector(): Promise<{ selector: OAuthSelectorComponent; selected: string[] }> {
	const authStorage = await AuthStorage.create(":memory:");
	const selected: string[] = [];
	const selector = new OAuthSelectorComponent(
		"login",
		authStorage,
		id => selected.push(id),
		() => {},
	);
	return { selector, selected };
}

beforeEach(async () => {
	testTheme = await getThemeByName("red-claw");
	installTestTheme();
});

describe("OAuth selector filtering", () => {
	test("a provider ranked past the visible window is reachable by typing", async () => {
		// BizRouter ranks below the 10-row window, so it is not rendered on open.
		const { selector } = await createSelector();
		expect(renderedText(selector)).not.toContain("BizRouter");

		type(selector, "bizrouter");

		expect(renderedText(selector)).toContain("BizRouter");
	});

	test("enter selects the filtered match rather than the ranked-list entry at that index", async () => {
		const { selector, selected } = await createSelector();
		type(selector, "bizrouter");
		selector.handleInput("\n");

		expect(selected).toEqual(["bizrouter"]);
	});

	test("filtering matches on provider id as well as display name", async () => {
		const { selector, selected } = await createSelector();
		// "opengateway" is the id; the label is "OpenGateway by Sionic AI".
		type(selector, "opengateway");
		selector.handleInput("\n");

		expect(selected).toEqual(["opengateway"]);
	});

	test("clearing the query restores the full list and keeps the matched provider selected", async () => {
		const { selector, selected } = await createSelector();
		const fullCount = getOAuthProviders().length;

		type(selector, "biz");
		selector.handleInput("\x7f"); // backspace
		selector.handleInput("\x7f");
		selector.handleInput("\x7f");

		// Every provider is listed again...
		expect(renderedText(selector)).toContain(`/${fullCount})`);
		// ...and the provider found via the filter stays selected, rather than the
		// cursor snapping back to the top of the restored list.
		selector.handleInput("\n");
		expect(selected).toEqual(["bizrouter"]);
	});

	test("bulk account removal requires confirmation and cancel leaves the callback untouched", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		const removed: unknown[] = [];
		const cancelled: boolean[] = [];
		let selector: OAuthSelectorComponent | undefined;

		try {
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "access-account-a",
					refresh: "refresh-account-a",
					expires: Date.now() + 60_000,
					accountId: "account-a",
					email: "a@example.com",
				},
				{
					type: "oauth",
					access: "access-account-b",
					refresh: "refresh-account-b",
					expires: Date.now() + 60_000,
					accountId: "account-b",
					email: "b@example.com",
				},
			]);
			selector = new OAuthSelectorComponent(
				"logout",
				authStorage,
				() => {},
				() => cancelled.push(true),
				{
					accountProviderId: "anthropic",
					onAccountRemove: targets => {
						removed.push(targets);
					},
				},
			);

			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");
			selector.handleInput("\n");

			expect(removed).toHaveLength(0);
			expect(renderedText(selector)).toContain("Remove all 2 accounts? Enter to confirm, Esc to cancel");

			selector.handleInput("\x1b");
			expect(removed).toHaveLength(0);
			expect(cancelled).toHaveLength(1);
		} finally {
			selector?.dispose();
			authStorage.close();
		}
	});
	test("logout lists and removes api-key rows alongside oauth rows (mixed provider)", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		const removed: unknown[][] = [];
		let selector: OAuthSelectorComponent | undefined;

		try {
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "access-account-a",
					refresh: "refresh-account-a",
					expires: Date.now() + 60_000,
					accountId: "account-a",
					email: "a@example.com",
				},
				{ type: "api_key", key: "sk-mixed-provider-key" },
			]);
			selector = new OAuthSelectorComponent(
				"logout",
				authStorage,
				() => {},
				() => {},
				{
					accountProviderId: "anthropic",
					onAccountRemove: targets => {
						removed.push([...targets]);
					},
				},
			);

			// Both credential kinds are listed and selectable in logout mode.
			const rendered = renderedText(selector);
			expect(rendered).toContain("a@example.com");
			expect(rendered).toContain("API key · row 2");

			// Cursor starts on the oauth row; move down to the api-key row.
			selector.handleInput("\x1b[B");
			selector.handleInput("\n");
			expect(removed).toHaveLength(0);
			expect(renderedText(selector)).toContain("Remove this account? Enter to confirm, Esc to cancel");

			selector.handleInput("\n");

			expect(removed).toHaveLength(1);
			const [targets] = removed;
			expect(targets).toHaveLength(1);
			expect(String(JSON.stringify(targets))).toContain('"id":2');
		} finally {
			selector?.dispose();
			authStorage.close();
		}
	});

	test("OAuth account choices are disabled while an API-key override is active", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		const selected: unknown[] = [];
		let selector: OAuthSelectorComponent | undefined;
		try {
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "access-account-a",
					refresh: "refresh-account-a",
					expires: Date.now() + 60_000,
					accountId: "account-a",
					email: "a@example.com",
				},
			]);
			authStorage.setRuntimeApiKey("anthropic", "runtime-secret");
			selector = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{
					accountProviderId: "anthropic",
					onAccountSelect: value => {
						selected.push(value);
					},
				},
			);

			// Login defaults to the first selectable recovery action; move back to
			// the disabled account to verify it still cannot be selected.
			selector.handleInput("\x1b[A");
			selector.handleInput("\n");

			expect(selected).toEqual([]);
			expect(renderedText(selector)).toContain("This account is not selectable.");
		} finally {
			selector?.dispose();
			authStorage.close();
		}
	});
	test("a disabled OAuth account defaults Enter to adding a fresh account", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		const added: boolean[] = [];
		let selector: OAuthSelectorComponent | undefined;
		try {
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "expired-access",
					refresh: "expired-refresh",
					expires: Date.now() - 60_000,
					accountId: "expired-account",
					email: "expired@example.com",
				},
			]);
			const credential = authStorage.listCredentialInventory("anthropic")[0];
			if (!credential) throw new Error("Expected OAuth credential fixture");
			expect(authStorage.disableCredentialById(credential.id, "oauth refresh failed: invalid_grant")).toBe(true);

			selector = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{
					accountProviderId: "anthropic",
					onAddAccount: () => {
						added.push(true);
					},
				},
			);

			selector.handleInput("\n");

			expect(added).toEqual([true]);
			expect(renderedText(selector)).not.toContain("This account is not selectable.");
		} finally {
			selector?.dispose();
			authStorage.close();
		}
	});
	test("a selectable OAuth account remains the default login choice", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		const selected: unknown[] = [];
		let selector: OAuthSelectorComponent | undefined;
		try {
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "active-access",
					refresh: "active-refresh",
					expires: Date.now() + 60_000,
					accountId: "active-account",
					email: "active@example.com",
				},
			]);
			const credential = authStorage.listCredentialInventory("anthropic")[0];
			if (!credential) throw new Error("Expected OAuth credential fixture");

			selector = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{
					accountProviderId: "anthropic",
					onAccountSelect: value => {
						selected.push(value);
					},
					onAddAccount: () => {},
				},
			);

			selector.handleInput("\n");

			expect(selected).toEqual([{ kind: "id", value: String(credential.id) }]);
		} finally {
			selector?.dispose();
			authStorage.close();
		}
	});
	test("a non-matching query reports no matches instead of an empty list", async () => {
		const { selector } = await createSelector();
		type(selector, "zzzznotaprovider");

		const rendered = renderedText(selector);
		expect(rendered).toContain("No providers match the filter");
		// The generic "none available" copy would be wrong here: providers exist.
		expect(rendered).not.toContain("No OAuth providers available");
	});

	test("enter on a non-matching query selects nothing", async () => {
		const { selector, selected } = await createSelector();
		type(selector, "zzzznotaprovider");
		selector.handleInput("\n");

		expect(selected).toEqual([]);
	});

	test("arrow keys still navigate and do not leak into the filter", async () => {
		const { selector, selected } = await createSelector();
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(1);

		selector.handleInput("\x1b[B"); // down
		selector.handleInput("\n");

		// Selection moved off the first entry, and the query stayed empty.
		expect(selected).toHaveLength(1);
		expect(selected[0]).not.toBe(providers[0]?.id);
		expect(renderedText(selector)).not.toContain("No providers match the filter");
	});

	test("changing the query resets selection to the best match", async () => {
		const { selector, selected } = await createSelector();
		// Move the cursor down, then type: the new query must re-anchor selection
		// at index 0 rather than keeping a stale offset into the old list.
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		type(selector, "bizrouter");
		selector.handleInput("\n");

		expect(selected).toEqual(["bizrouter"]);
	});
});
