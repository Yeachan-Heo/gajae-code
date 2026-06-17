#!/usr/bin/env bun
/**
 * Entry point for the Telegram Remote gateway service. Reads configuration from
 * environment variables and runs the receive loop. Intended to be run as a small
 * PC-side or systemd-managed process, not as a core `gjc` mode.
 */
import { loadConfigFromEnv } from "./config";
import { runService } from "./service";

async function main(): Promise<void> {
	const config = loadConfigFromEnv(process.env);
	process.stderr.write(
		`[telegram-remote] starting (stop=${config.policy.enableStop ? "on" : "off"}, presets=${config.policy.presets.size})\n`,
	);
	await runService(config);
}

main().catch((error: unknown) => {
	process.stderr.write(`[telegram-remote] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
