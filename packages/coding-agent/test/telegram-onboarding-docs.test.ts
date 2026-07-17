import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

async function readRepoFile(...segments: string[]): Promise<string> {
	return await Bun.file(path.join(repoRoot, ...segments)).text();
}

describe("Telegram onboarding docs", () => {
	it("documents the supported fallback when BotFather lacks Threaded Mode settings", async () => {
		const onboarding = await readRepoFile("docs", "telegram-onboarding.md");
		const sdk = await readRepoFile("docs", "sdk.md");

		expect(onboarding).toContain("If BotFather's **Bot Settings** menu does not show **Threads Settings** or");
		expect(onboarding).toContain("do not treat that as a setup blocker");
		expect(onboarding).toContain("choose `skip` in the interactive prompt");
		expect(onboarding).toContain("continue with the saved private-chat\npairing; this is supported");
		expect(onboarding).toContain("no paid/Stars option is required just to receive flat private-chat\nnotifications");
		expect(onboarding).toContain("outbound notifications\nand inline ask buttons only");
		expect(onboarding).toContain("@BotFather > Bot Settings > Threads Settings");
		expect(onboarding).toContain("free-text replies and\nsession commands require Threaded Mode/topic routing");
		expect(onboarding).toContain("Do not\npair a group, supergroup, or channel as a substitute");
		expect(onboarding.toLowerCase()).not.toContain("mini" + "app");

		expect(sdk).toContain("If BotFather's per-bot **Bot Settings** menu does not show **Threads Settings**");
		expect(sdk).toContain("the supported fallback is the normal private-chat pairing");
		expect(sdk).toContain("Flat fallback keeps outbound notifications and inline-button answers working");
		expect(sdk).toContain("require Threaded Mode/topic routing");
		expect(sdk).toContain("@BotFather > Bot\nSettings > Threads Settings");
		expect(sdk).toContain("Do not pair a group, supergroup, or channel to work around a missing BotFather\nmenu");
		expect(sdk.toLowerCase()).not.toContain("mini" + "app");
	});

	it("documents Settings and CLI parity without weakening notification safety", async () => {
		const onboarding = await readRepoFile("docs", "telegram-onboarding.md");
		const sdk = await readRepoFile("docs", "sdk.md");

		expect(onboarding).toContain("open `/settings` and select the\n**Notifications** tab");
		expect(onboarding).toContain(
			"refresh or probe health, send a test notification, recover dead-owner\n  artifacts, and reconnect the Telegram runtime",
		);
		expect(onboarding).toContain("Telegram credentials and all `notifications.*` values are **global-only**");
		expect(onboarding).toContain(
			"project config files are ignored, and runtime notification overrides\nare rejected",
		);
		expect(onboarding).toContain("`GJC_NOTIFY=off`, `0`, or `false`");
		expect(onboarding).toContain("`GJC_NOTIFICATIONS=1` or `GJC_NOTIFICATIONS_TOKEN`");
		expect(onboarding).toContain("GJC performs zero `getUpdates` discovery polls");
		expect(onboarding).toContain("does not poll, kill, reload, or take over the\nowner");
		expect(onboarding).toContain("The raw token is never printed by GJC status/setup output after it is stored");
		expect(onboarding).toContain(
			"`gjc notify setup`, `gjc notify status`, `gjc notify health`, `gjc notify\ntest`, and `gjc notify recovery`",
		);

		expect(sdk).toContain("The recommended interactive path is `/settings` → **Notifications**");
		expect(sdk).toContain("`gjc notify setup` remains the authoritative CLI fallback for headless and");
		expect(sdk).toContain("Project notification keys are\nignored and runtime notification overrides are rejected");
		expect(sdk).toContain("A foreign or unknown owner is never killed, reloaded, or taken over");
	});
});
