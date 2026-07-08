import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import type { Settings } from "../src/config/settings";
import { getNotificationConfig } from "../src/notifications/config";
import { createLightweightDaemonSettings } from "../src/notifications/telegram-daemon-cli";

// The daemon is spawned as a lightweight process that reads config.yml into a
// raw object and exposes it through createLightweightDaemonSettings, NOT the
// full Settings class. These tests prove the rich setting survives that reduced
// path end-to-end (raw YAML object -> getNotificationConfig.rich).
function cfgFromRaw(rawConfig: unknown) {
	const settings = createLightweightDaemonSettings({ agentDir: "/tmp/gjc-rich-config", rawConfig });
	return getNotificationConfig(settings as Settings);
}

describe("notifications daemon config reachability (rich)", () => {
	test("rich enabled reaches getNotificationConfig from a raw YAML object", () => {
		const cfg = cfgFromRaw({
			notifications: {
				enabled: true,
				telegram: {
					botToken: "123456:secret",
					chatId: "42",
					rich: { enabled: false },
				},
			},
		});
		expect(cfg.rich.enabled).toBe(false);
	});

	test("missing rich defaults to enabled", () => {
		const cfg = cfgFromRaw({ notifications: { enabled: true } });
		expect(cfg.rich.enabled).toBe(true);
	});

	test("an entirely empty raw config still yields a safe rich default", () => {
		const cfg = cfgFromRaw({});
		expect(cfg.rich).toEqual({ enabled: true });
	});

	test("non-boolean enabled coerces to default", () => {
		const cfg = cfgFromRaw({ notifications: { telegram: { rich: { enabled: "yes" } } } });
		expect(cfg.rich.enabled).toBe(true);
	});

	test("stale richFinal config is ignored", () => {
		const cfg = cfgFromRaw({ notifications: { telegram: { richFinal: { enabled: false, topicId: "9001" } } } });
		expect(cfg.rich).toEqual({ enabled: true });
	});
});

describe("lightweight daemon settings set() persists via lock + partial merge", () => {
	test("flips rich.enabled and preserves unrelated keys, including a concurrent write", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-rich-set-"));
		const configPath = path.join(agentDir, "config.yml");
		fs.writeFileSync(
			configPath,
			YAML.stringify({
				notifications: { telegram: { botToken: "tok", chatId: "42", rich: { enabled: true } } },
				model: "keep-me",
			}),
		);
		// The daemon loaded this snapshot at startup...
		const rawConfig = YAML.parse(fs.readFileSync(configPath, "utf8"));
		const s = createLightweightDaemonSettings({ agentDir, rawConfig }) as unknown as {
			set(k: string, v: unknown): Promise<void>;
			get(k: string): unknown;
		};
		// ...then a concurrent main-process save adds an unrelated key to config.yml.
		const concurrent = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;
		concurrent.notifications.discord = { botToken: "d" };
		fs.writeFileSync(configPath, YAML.stringify(concurrent));

		await s.set("notifications.telegram.rich.enabled", false);

		// set() re-reads under the lock and patches only its key: the flip lands AND
		// the concurrently-written key survives (no whole-file last-writer-wins clobber).
		const onDisk = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;
		expect(onDisk.notifications.telegram.rich.enabled).toBe(false);
		expect(onDisk.notifications.discord.botToken).toBe("d");
		expect(onDisk.notifications.telegram.botToken).toBe("tok");
		expect(onDisk.model).toBe("keep-me");
		// In-memory view reflects the write.
		expect(s.get("notifications.telegram.rich.enabled")).toBe(false);

		fs.rmSync(agentDir, { recursive: true, force: true });
	});
});
