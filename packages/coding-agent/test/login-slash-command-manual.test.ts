import { beforeAll, describe, expect, it, vi } from "bun:test";
import { OAuthManualInputManager } from "@gajae-code/coding-agent/modes/oauth-manual-input";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/builtin-registry";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

function createLoginRuntime() {
	const oauthManualInput = new OAuthManualInputManager();
	const showOAuthSelector = vi.fn();
	const showWarning = vi.fn();
	const showStatus = vi.fn();
	const submit = vi.spyOn(oauthManualInput, "submit");
	const ctx = {
		oauthManualInput,
		showOAuthSelector,
		showWarning,
		showStatus,
		editor: { setText: vi.fn() },
	} as unknown as InteractiveModeContext;

	return {
		runtime: { ctx, handleBackgroundCommand: () => undefined },
		oauthManualInput,
		showOAuthSelector,
		showWarning,
		showStatus,
		submit,
	};
}

describe("/login --manual", () => {
	it("starts a paste-a-code login instead of submitting the flag as a callback value", async () => {
		const { runtime, showOAuthSelector, submit } = createLoginRuntime();

		await executeBuiltinSlashCommand("/login anthropic --manual", runtime);

		expect(showOAuthSelector).toHaveBeenCalledWith("login", "anthropic", { manualCode: true });
		expect(submit).not.toHaveBeenCalled();
	});

	it("keeps the plain provider login on the loopback callback", async () => {
		const { runtime, showOAuthSelector } = createLoginRuntime();

		await executeBuiltinSlashCommand("/login anthropic", runtime);

		expect(showOAuthSelector).toHaveBeenCalledWith("login", "anthropic");
	});

	it("refuses the flag without a provider rather than guessing one", async () => {
		const { runtime, showOAuthSelector, showWarning, submit } = createLoginRuntime();

		await executeBuiltinSlashCommand("/login --manual", runtime);

		expect(showWarning).toHaveBeenCalledWith("Usage: /login <provider> --manual");
		expect(showOAuthSelector).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});

	it("refuses the flag with an unknown provider rather than pasting it as a code", async () => {
		const { runtime, showOAuthSelector, showWarning, submit } = createLoginRuntime();

		await executeBuiltinSlashCommand("/login not-a-provider --manual", runtime);

		expect(showWarning).toHaveBeenCalledWith("Usage: /login <provider> --manual");
		expect(showOAuthSelector).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});

	it("still routes a pasted callback value to the waiting login", async () => {
		const { runtime, oauthManualInput, showOAuthSelector, showStatus } = createLoginRuntime();
		const pending = oauthManualInput.waitForInput("anthropic");

		await executeBuiltinSlashCommand("/login http://localhost:54545/callback?code=abc&state=xyz", runtime);

		expect(await pending).toBe("http://localhost:54545/callback?code=abc&state=xyz");
		expect(showStatus).toHaveBeenCalledWith("OAuth callback received; completing login…");
		expect(showOAuthSelector).not.toHaveBeenCalled();
	});

	it("does not start a second login while one is waiting for a code", async () => {
		const { runtime, oauthManualInput, showOAuthSelector, showWarning } = createLoginRuntime();
		const pending = oauthManualInput.waitForInput("anthropic");

		await executeBuiltinSlashCommand("/login anthropic --manual", runtime);

		expect(showOAuthSelector).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(
			"OAuth login already in progress for anthropic. Paste the redirect URL with /login <url>.",
		);
		oauthManualInput.clear();
		await expect(pending).rejects.toThrow();
	});
});
