// Prints whether the notifications channel resolves as enabled in this process.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
import { $credentialEnv } from "@gajae-code/utils";
import { notificationsEnabled } from "../../src/sdk/bus";

console.log(
	JSON.stringify({
		enabled: notificationsEnabled(),
		// telegram-cli resolves its bot token through the same resolver
		botToken: $credentialEnv("GJC_TG_BOT_TOKEN") ?? null,
	}),
);
