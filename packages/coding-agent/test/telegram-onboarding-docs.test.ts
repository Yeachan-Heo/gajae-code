import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

async function readRepoFile(...segments: string[]): Promise<string> {
	return await Bun.file(path.join(repoRoot, ...segments)).text();
}

describe("Telegram onboarding docs", () => {
	it("documents the supported fallback when BotFather lacks Threaded Mode settings", async () => {
		const onboarding = await readRepoFile("docs", "telegram-onboarding.md");
		const sdk = await readRepoFile("docs", "notifications-sdk.md");

		expect(onboarding).toContain("If BotFather's **Bot Settings** menu does not show **Threads Settings** or");
		expect(onboarding).toContain("do not treat that as a setup blocker");
		expect(onboarding).toContain("choose `skip` in the interactive prompt");
		expect(onboarding).toContain("continue with the saved private-chat\npairing; this is supported");
		expect(onboarding).toContain("no paid/Stars option is required just to receive flat private-chat\nnotifications");
		expect(onboarding).toContain("Do not\npair a group, supergroup, or channel as a substitute");

		expect(sdk).toContain("If BotFather's per-bot **Bot Settings** menu does not show **Threads Settings**");
		expect(sdk).toContain("the supported fallback is the normal private-chat pairing");
		expect(sdk).toContain("Flat fallback keeps outbound notifications and inline-button answers working");
		expect(sdk).toContain("Do not pair a group, supergroup, or\nchannel to work around a missing BotFather menu");
	});
});
