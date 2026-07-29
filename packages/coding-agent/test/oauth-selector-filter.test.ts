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
