import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { Settings } from "../src/config/settings";
import {
	getNotificationConfig,
	hasAnyEffectivelyEnabledProvider,
	isDiscordComplete,
	isSlackComplete,
} from "../src/sdk/bus/config";
import { createLightweightDaemonSettings, loadLightweightDaemonSettings } from "../src/sdk/bus/telegram-daemon-cli";

// The daemon is spawned as a lightweight process that reads config.yml into a
// raw object and exposes it through createLightweightDaemonSettings, NOT the
// full Settings class. These tests prove the rich setting survives that reduced
// path end-to-end (raw YAML object -> getNotificationConfig.rich).
function cfgFromRaw(rawConfig: unknown) {
	const settings = createLightweightDaemonSettings({ agentDir: "/tmp/gjc-rich-config", rawConfig });
	return getNotificationConfig(settings);
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

	test("provider-local malformed booleans are quarantined with safe defaults", () => {
		const rich = cfgFromRaw({ notifications: { telegram: { rich: { enabled: "yes" } } } });
		expect(rich.rich.enabled).toBe(true);
		expect(rich.providerIssues?.telegram).toContainEqual({
			path: "notifications.telegram.rich.enabled",
			code: "wrong_type",
		});
		const btw = cfgFromRaw(YAML.parse('notifications:\n  telegram:\n    btw:\n      enabled: "false"\n'));
		expect(btw.btw.enabled).toBe(true);
		expect(btw.providerIssues?.telegram).toContainEqual({
			path: "notifications.telegram.btw.enabled",
			code: "wrong_type",
		});
	});

	test("stale richFinal config is ignored", () => {
		const cfg = cfgFromRaw({ notifications: { telegram: { richFinal: { enabled: false, topicId: "9001" } } } });
		expect(cfg.rich).toEqual({ enabled: true });
	});

	test("topics.nameTemplate reaches getNotificationConfig from a raw YAML object", () => {
		const cfg = cfgFromRaw({
			notifications: {
				enabled: true,
				telegram: {
					botToken: "123456:secret",
					chatId: "42",
					topics: { nameTemplate: "{title} · {repo}/{branch}" },
				},
			},
		});
		expect(cfg.topics.nameTemplate).toBe("{title} · {repo}/{branch}");
	});

	test("missing topics.nameTemplate is undefined", () => {
		expect(cfgFromRaw({ notifications: { enabled: true } }).topics.nameTemplate).toBeUndefined();
	});

	test("quarantines an explicitly malformed topics.nameTemplate", () => {
		const cfg = cfgFromRaw({ notifications: { telegram: { topics: { nameTemplate: 42 } } } });
		expect(cfg.topics.nameTemplate).toBeUndefined();
		expect(cfg.providerIssues?.telegram).toContainEqual({
			path: "notifications.telegram.topics.nameTemplate",
			code: "wrong_type",
		});
	});
});

describe("notifications daemon config reachability (streaming)", () => {
	test("defaults enabled in resolved settings and reaches the lightweight daemon reader", () => {
		expect(Settings.isolated({}).getNotificationSettingsSnapshot().telegram.streaming).toEqual({ enabled: true });
		expect(cfgFromRaw({}).streaming).toEqual({ enabled: true });
		expect(cfgFromRaw({ notifications: { telegram: { streaming: { enabled: false } } } }).streaming).toEqual({
			enabled: false,
		});
	});

	test("quarantines malformed streaming containers and enabled values", () => {
		for (const [rawConfig, pathName] of [
			[{ notifications: { telegram: { streaming: true } } }, "notifications.telegram.streaming"],
			[
				{ notifications: { telegram: { streaming: { enabled: "false" } } } },
				"notifications.telegram.streaming.enabled",
			],
		] as const) {
			const cfg = cfgFromRaw(rawConfig);
			expect(cfg.streaming).toEqual({ enabled: true });
			expect((cfg.providerIssues?.telegram ?? []).some(issue => issue.path === pathName)).toBe(true);
		}
	});
});
describe("notifications daemon config reachability (btw)", () => {
	test("defaults enabled in both resolved settings and the lightweight daemon reader", () => {
		expect(Settings.isolated({}).getNotificationSettingsSnapshot().telegram.btw).toEqual({ enabled: true });
		expect(cfgFromRaw({}).btw).toEqual({ enabled: true });
	});
	test("rejects malformed global roots and quarantines malformed Telegram containers", () => {
		for (const rawConfig of [true, { notifications: true }]) {
			expect(() => cfgFromRaw(rawConfig)).toThrow("gjc_notify_daemon_invalid_configuration");
		}
		for (const [rawConfig, pathName] of [
			[{ notifications: { telegram: [] } }, "notifications.telegram"],
			[{ notifications: { telegram: { btw: true } } }, "notifications.telegram.btw"],
		] as const) {
			const cfg = cfgFromRaw(rawConfig);
			expect(cfg.btw).toEqual({ enabled: true });
			expect((cfg.providerIssues?.telegram ?? []).some(issue => issue.path === pathName)).toBe(true);
		}
	});
	test("explicit malformed idle timeout throws instead of silently defaulting", () => {
		expect(() => cfgFromRaw({ notifications: { daemon: { idleTimeoutMs: 0 } } })).toThrow(
			"gjc_notify_daemon_invalid_configuration",
		);
	});

	test("persists, reloads, and re-enables btw without exposing notification secrets", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-btw-set-"));
		const configPath = path.join(agentDir, "config.yml");
		fs.writeFileSync(
			configPath,
			YAML.stringify({
				notifications: { telegram: { botToken: "secret-token", chatId: "42" } },
			}),
		);

		const settings = createLightweightDaemonSettings({
			agentDir,
			rawConfig: YAML.parse(fs.readFileSync(configPath, "utf8")),
		});
		await settings.set("notifications.telegram.btw.enabled", false);
		expect(settings.get("notifications.telegram.btw.enabled")).toBe(false);

		const disabled = await loadLightweightDaemonSettings(agentDir);
		expect(getNotificationConfig(disabled).btw).toEqual({ enabled: false });

		await disabled.set("notifications.telegram.btw.enabled", true);
		const reenabled = await loadLightweightDaemonSettings(agentDir);
		expect(getNotificationConfig(reenabled).btw).toEqual({ enabled: true });

		fs.rmSync(agentDir, { recursive: true, force: true });
	});
});

describe("notifications daemon config reachability (providers)", () => {
	test("complete providers are reachable and partial providers are rejected", () => {
		const completeDiscord = cfgFromRaw({
			notifications: {
				enabled: true,
				discord: { botToken: "discord-secret", applicationId: "app", guildId: "guild", parentChannelId: "parent" },
			},
		});
		expect(isDiscordComplete(completeDiscord)).toBe(true);
		expect(hasAnyEffectivelyEnabledProvider(completeDiscord)).toBe(true);
		const partialDiscord = cfgFromRaw({ notifications: { enabled: true, discord: { botToken: "discord-secret" } } });
		expect(isDiscordComplete(partialDiscord)).toBe(false);
		expect(hasAnyEffectivelyEnabledProvider(partialDiscord)).toBe(false);

		const completeSlack = cfgFromRaw({
			notifications: {
				enabled: true,
				slack: {
					botToken: "slack-bot-secret",
					appToken: "slack-app-secret",
					workspaceId: "workspace",
					channelId: "channel",
				},
			},
		});
		expect(isSlackComplete(completeSlack)).toBe(true);
		expect(hasAnyEffectivelyEnabledProvider(completeSlack)).toBe(true);
		const partialSlack = cfgFromRaw({
			notifications: { enabled: true, slack: { botToken: "slack-bot-secret", appToken: "slack-app-secret" } },
		});
		expect(isSlackComplete(partialSlack)).toBe(false);
		expect(hasAnyEffectivelyEnabledProvider(partialSlack)).toBe(false);
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
		const s = createLightweightDaemonSettings({ agentDir, rawConfig });
		// ...then a concurrent main-process save adds an unrelated key to config.yml.
		const concurrent = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
			notifications: {
				telegram: { botToken: string; chatId: string; rich: { enabled: boolean } };
				discord?: { botToken: string };
			};
			model: string;
		};
		concurrent.notifications.discord = { botToken: "d" };
		fs.writeFileSync(configPath, YAML.stringify(concurrent));

		await s.set("notifications.telegram.rich.enabled", false);

		// set() re-reads under the lock and patches only its key: the flip lands AND
		// the concurrently-written key survives (no whole-file last-writer-wins clobber).
		const onDisk = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
			notifications: {
				telegram: { botToken: string; chatId: string; rich: { enabled: boolean } };
				discord?: { botToken: string };
			};
			model: string;
		};
		expect(onDisk.notifications.telegram.rich.enabled).toBe(false);
		expect(onDisk.notifications.discord?.botToken).toBe("d");
		expect(onDisk.notifications.telegram.botToken).toBe("tok");
		expect(onDisk.model).toBe("keep-me");
		// In-memory view reflects the write.
		expect(s.get("notifications.telegram.rich.enabled")).toBe(false);

		fs.rmSync(agentDir, { recursive: true, force: true });
	});
});
