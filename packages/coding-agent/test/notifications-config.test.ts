import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/extensibility/extensions";
import { createAgentSession } from "../src/sdk";
import {
	buildRedactedAction,
	completionNotifyDisabledByEnv,
	getNotificationConfig,
	isDiscordConfigured,
	isGloballyConfigured,
	isSessionNotificationsEnabled,
	isSlackConfigured,
	isTelegramConfigured,
	maskToken,
	type NotificationConfig,
	type RedactableAction,
	sessionTag,
	shouldRegisterNotificationsExtension,
	tokenFingerprint,
} from "../src/sdk/bus/config";
import { createNotificationsExtension } from "../src/sdk/bus/index";
import { daemonPaths, ensureTelegramDaemonRunning } from "../src/sdk/bus/telegram-daemon";
import { SessionManager } from "../src/session/session-manager";

const BASE_CFG: NotificationConfig = {
	enabled: false,
	botToken: undefined,
	chatId: undefined,
	discord: {
		botToken: undefined,
		applicationId: undefined,
		guildId: undefined,
		parentChannelId: undefined,
	},
	slack: {
		botToken: undefined,
		appToken: undefined,
		workspaceId: undefined,
		channelId: undefined,
		authorizedUserId: undefined,
	},
	redact: false,
	verbosity: "lean",
	sessionScope: "all",
	rich: {
		enabled: true,
	},
	richDraft: {
		enabled: false,
	},
	topics: {
		nameTemplate: undefined,
	},
	idleTimeoutMs: 60000,
};

const GLOBAL_CFG: NotificationConfig = {
	...BASE_CFG,
	enabled: true,
	botToken: "1234567890:abc",
	chatId: "chat-1",
};
const PRIMARY_GLOBAL_CFG: NotificationConfig = {
	...GLOBAL_CFG,
	sessionScope: "primary",
};
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("notifications config", () => {
	test("getNotificationConfig reads defaults", () => {
		expect(getNotificationConfig(Settings.isolated())).toEqual(BASE_CFG);
	});

	test("getNotificationConfig reads populated settings", () => {
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": "token-1",
			"notifications.telegram.chatId": "chat-1",
			"notifications.discord.botToken": "discord-token",
			"notifications.discord.applicationId": "discord-app",
			"notifications.discord.guildId": "discord-guild",
			"notifications.discord.parentChannelId": "discord-parent",
			"notifications.slack.botToken": "slack-token",
			"notifications.slack.appToken": "slack-app-token",
			"notifications.slack.workspaceId": "slack-workspace",
			"notifications.slack.channelId": "slack-channel",
			"notifications.slack.authorizedUserId": "slack-user",
			"notifications.redact": true,
			"notifications.daemon.idleTimeoutMs": 1234,
		});

		expect(getNotificationConfig(settings)).toEqual({
			enabled: true,
			botToken: "token-1",
			chatId: "chat-1",
			discord: {
				botToken: "discord-token",
				applicationId: "discord-app",
				guildId: "discord-guild",
				parentChannelId: "discord-parent",
			},
			slack: {
				botToken: "slack-token",
				appToken: "slack-app-token",
				workspaceId: "slack-workspace",
				channelId: "slack-channel",
				authorizedUserId: "slack-user",
			},
			redact: true,
			verbosity: "lean",
			sessionScope: "all",
			rich: {
				enabled: true,
			},
			richDraft: {
				enabled: false,
			},
			topics: {
				nameTemplate: undefined,
			},
			idleTimeoutMs: 1234,
		});
	});

	test("chat adapter guards require every non-blank credential and routing identifier", () => {
		const discord: NotificationConfig = {
			...BASE_CFG,
			enabled: true,
			discord: {
				botToken: "discord-token",
				applicationId: "discord-app",
				guildId: "discord-guild",
				parentChannelId: "discord-parent",
			},
		};
		const slack: NotificationConfig = {
			...BASE_CFG,
			enabled: true,
			slack: {
				botToken: "slack-token",
				appToken: "slack-app-token",
				workspaceId: "workspace",
				channelId: "channel",
				authorizedUserId: "slack-user",
			},
		};

		expect(isDiscordConfigured(discord)).toBe(true);
		expect(isDiscordConfigured({ ...discord, discord: { ...discord.discord, guildId: " " } })).toBe(false);
		expect(isDiscordConfigured({ ...discord, discord: { ...discord.discord, parentChannelId: undefined } })).toBe(
			false,
		);
		expect(isSlackConfigured(slack)).toBe(true);
		expect(isSlackConfigured({ ...slack, slack: { ...slack.slack, appToken: "\t" } })).toBe(false);
		expect(isGloballyConfigured(discord)).toBe(true);
		expect(isGloballyConfigured(slack)).toBe(true);
		expect(isGloballyConfigured({ ...discord, enabled: false })).toBe(false);
	});

	test("isTelegramConfigured rejects blank Telegram credentials even when another adapter is configured", () => {
		const mixedAdapterCfg: NotificationConfig = {
			...BASE_CFG,
			enabled: true,
			botToken: " ",
			chatId: "\t",
			discord: { botToken: "discord-token", applicationId: "app", guildId: "guild", parentChannelId: "parent" },
		};

		expect(isGloballyConfigured(mixedAdapterCfg)).toBe(true);
		expect(isTelegramConfigured(mixedAdapterCfg)).toBe(false);
	});

	test("isSessionNotificationsEnabled applies precedence", () => {
		expect(
			isSessionNotificationsEnabled({
				cfg: GLOBAL_CFG,
				env: { GJC_NOTIFICATIONS: "0", GJC_NOTIFICATIONS_TOKEN: "token" },
				sessionDisabled: false,
			}),
		).toBe(false);

		expect(
			isSessionNotificationsEnabled({
				cfg: GLOBAL_CFG,
				env: { GJC_NOTIFICATIONS: "1" },
				sessionDisabled: true,
			}),
		).toBe(false);

		expect(
			isSessionNotificationsEnabled({ cfg: BASE_CFG, env: { GJC_NOTIFICATIONS: "1" }, sessionDisabled: false }),
		).toBe(true);
		expect(
			isSessionNotificationsEnabled({
				cfg: BASE_CFG,
				env: { GJC_NOTIFICATIONS_TOKEN: "legacy-token" },
				sessionDisabled: false,
			}),
		).toBe(true);

		expect(isSessionNotificationsEnabled({ cfg: GLOBAL_CFG, env: {}, sessionDisabled: false })).toBe(true);
		expect(isSessionNotificationsEnabled({ cfg: BASE_CFG, env: {}, sessionDisabled: false })).toBe(false);
		expect(
			isSessionNotificationsEnabled({
				cfg: PRIMARY_GLOBAL_CFG,
				env: {},
				sessionDisabled: false,
				spawnedByGjc: true,
			}),
		).toBe(false);
		expect(
			isSessionNotificationsEnabled({
				cfg: PRIMARY_GLOBAL_CFG,
				env: { GJC_NOTIFICATIONS: "1" },
				sessionDisabled: false,
				spawnedByGjc: true,
			}),
		).toBe(true);
	});

	test("shouldRegisterNotificationsExtension applies registration precedence", () => {
		expect(
			shouldRegisterNotificationsExtension({
				cfg: GLOBAL_CFG,
				env: { GJC_NOTIFICATIONS: "0", GJC_NOTIFICATIONS_TOKEN: "token" },
			}),
		).toBe(false);
		expect(shouldRegisterNotificationsExtension({ cfg: BASE_CFG, env: { GJC_NOTIFICATIONS: "1" } })).toBe(true);
		expect(
			shouldRegisterNotificationsExtension({ cfg: BASE_CFG, env: { GJC_NOTIFICATIONS_TOKEN: "legacy-token" } }),
		).toBe(true);
		expect(shouldRegisterNotificationsExtension({ cfg: GLOBAL_CFG, env: {} })).toBe(true);
		expect(shouldRegisterNotificationsExtension({ cfg: BASE_CFG, env: {} })).toBe(false);
		expect(shouldRegisterNotificationsExtension({ env: {} })).toBe(false);
		expect(
			shouldRegisterNotificationsExtension({
				cfg: GLOBAL_CFG,
				env: { GJC_NOTIFY: "off" },
			}),
		).toBe(false);
		expect(
			shouldRegisterNotificationsExtension({
				cfg: BASE_CFG,
				env: { GJC_NOTIFY: "FALSE", GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_TOKEN: "legacy-token" },
			}),
		).toBe(false);
		expect(completionNotifyDisabledByEnv({ GJC_NOTIFY: " 0 " })).toBe(true);
		expect(
			shouldRegisterNotificationsExtension({
				cfg: GLOBAL_CFG,
				env: { GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_TOKEN: "legacy-token" },
				taskDepth: 1,
			}),
		).toBe(false);
		expect(
			shouldRegisterNotificationsExtension({
				cfg: GLOBAL_CFG,
				env: { GJC_NOTIFICATIONS: "1" },
				parentTaskPrefix: "0-Sub",
			}),
		).toBe(false);
		expect(
			shouldRegisterNotificationsExtension({
				cfg: GLOBAL_CFG,
				env: { GJC_NOTIFICATIONS: "1" },
				currentAgentType: "executor",
			}),
		).toBe(false);
	});

	test("getNotificationConfig reads sessionScope", () => {
		expect(getNotificationConfig(Settings.isolated()).sessionScope).toBe("all");
		expect(getNotificationConfig(Settings.isolated({ "notifications.sessionScope": "primary" })).sessionScope).toBe(
			"primary",
		);
		// Unknown / malformed values fall back to the behavior-preserving default.
		expect(getNotificationConfig(Settings.isolated({ "notifications.sessionScope": "all" })).sessionScope).toBe(
			"all",
		);
	});

	test("sessionScope=primary suppresses GJC-spawned children but preserves everything else", () => {
		// Default scope "all": a spawned child still registers (fully behavior-preserving).
		expect(shouldRegisterNotificationsExtension({ cfg: GLOBAL_CFG, env: {}, spawnedByGjc: true })).toBe(true);
		// scope "primary": a spawned child is suppressed.
		expect(shouldRegisterNotificationsExtension({ cfg: PRIMARY_GLOBAL_CFG, env: {}, spawnedByGjc: true })).toBe(
			false,
		);
		// scope "primary": a user-opened session (no marker) is unaffected.
		expect(shouldRegisterNotificationsExtension({ cfg: PRIMARY_GLOBAL_CFG, env: {}, spawnedByGjc: false })).toBe(
			true,
		);
		expect(shouldRegisterNotificationsExtension({ cfg: PRIMARY_GLOBAL_CFG, env: {} })).toBe(true);
	});

	test("explicit /session_create opt-in outranks sessionScope=primary suppression", () => {
		// GJC_NOTIFICATIONS=1 is exactly what Telegram /session_create and cold
		// /session_resume launch with, so their bidirectional topic survives.
		expect(
			shouldRegisterNotificationsExtension({
				cfg: PRIMARY_GLOBAL_CFG,
				env: { GJC_NOTIFICATIONS: "1" },
				spawnedByGjc: true,
			}),
		).toBe(true);
		expect(
			shouldRegisterNotificationsExtension({
				cfg: PRIMARY_GLOBAL_CFG,
				env: { GJC_NOTIFICATIONS_TOKEN: "legacy-token" },
				spawnedByGjc: true,
			}),
		).toBe(true);
		// Hard opt-out and /notify off equivalents still outrank the marker.
		expect(
			shouldRegisterNotificationsExtension({
				cfg: PRIMARY_GLOBAL_CFG,
				env: { GJC_NOTIFICATIONS: "0" },
				spawnedByGjc: true,
			}),
		).toBe(false);
		expect(
			shouldRegisterNotificationsExtension({
				cfg: PRIMARY_GLOBAL_CFG,
				env: { GJC_NOTIFY: "off" },
				spawnedByGjc: true,
			}),
		).toBe(false);
		// A spawned child that is also a subagent stays suppressed regardless.
		expect(
			shouldRegisterNotificationsExtension({
				cfg: PRIMARY_GLOBAL_CFG,
				env: {},
				spawnedByGjc: true,
				taskDepth: 1,
			}),
		).toBe(false);
		// Without any configured adapter, a marker under primary is still off (no
		// spurious enable, and global auto-on is never reached).
		expect(shouldRegisterNotificationsExtension({ cfg: BASE_CFG, env: {}, spawnedByGjc: true })).toBe(false);
	});
	test("settings-enabled subagent sessions do not register the notifications extension", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-subagent-"));
		tempDirs.push(cwd);
		const previous = process.env.GJC_NOTIFICATIONS;
		delete process.env.GJC_NOTIFICATIONS;
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": " ",
			"notifications.telegram.chatId": "\t",
			"notifications.discord.botToken": "discord-token",
			"notifications.discord.applicationId": "discord-app",
			"notifications.discord.guildId": "discord-guild",
			"notifications.discord.parentChannelId": "discord-parent",
		});

		const disposers: Array<() => Promise<void>> = [];

		try {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, cwd, agentDir: cwd });
			const topLevel = await createAgentSession({
				cwd,
				agentDir: cwd,
				sessionManager: SessionManager.inMemory(cwd),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			disposers.push(() => topLevel.session.dispose());

			const subagent = await createAgentSession({
				cwd,
				agentDir: cwd,
				sessionManager: SessionManager.inMemory(cwd),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				taskDepth: 1,
			});
			disposers.push(() => subagent.session.dispose());
			const parentPrefixSubagent = await createAgentSession({
				cwd,
				agentDir: cwd,
				sessionManager: SessionManager.inMemory(cwd),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				parentTaskPrefix: "0-Sub",
			});
			disposers.push(() => parentPrefixSubagent.session.dispose());
			const agentTypeOnlySubagent = await createAgentSession({
				cwd,
				agentDir: cwd,
				sessionManager: SessionManager.inMemory(cwd),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				currentAgentType: "executor",
			});
			disposers.push(() => agentTypeOnlySubagent.session.dispose());
			const explicitExtensionSubagent = await createAgentSession({
				cwd,
				agentDir: cwd,
				sessionManager: SessionManager.inMemory(cwd),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				extensions: [api => createNotificationsExtension(api, { settings })],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				taskDepth: 1,
			});
			disposers.push(() => explicitExtensionSubagent.session.dispose());
			await topLevel.session.extensionRunner?.emit({ type: "session_start" });
			await subagent.session.extensionRunner?.emit({ type: "session_start" });
			await parentPrefixSubagent.session.extensionRunner?.emit({ type: "session_start" });
			await agentTypeOnlySubagent.session.extensionRunner?.emit({ type: "session_start" });
			await explicitExtensionSubagent.session.extensionRunner?.emit({ type: "session_start" });
			const topLevelEndpoint = path.join(cwd, ".gjc", "state", "sdk", `${topLevel.session.sessionId}.json`);
			const subagentEndpoint = path.join(cwd, ".gjc", "state", "sdk", `${subagent.session.sessionId}.json`);
			const parentPrefixSubagentEndpoint = path.join(
				cwd,
				".gjc",
				"state",
				"sdk",
				`${parentPrefixSubagent.session.sessionId}.json`,
			);
			const agentTypeOnlySubagentEndpoint = path.join(
				cwd,
				".gjc",
				"state",
				"sdk",
				`${agentTypeOnlySubagent.session.sessionId}.json`,
			);
			const explicitExtensionSubagentEndpoint = path.join(
				cwd,
				".gjc",
				"state",
				"sdk",
				`${explicitExtensionSubagent.session.sessionId}.json`,
			);
			expect(fs.existsSync(topLevelEndpoint)).toBe(true);
			expect(fs.existsSync(subagentEndpoint)).toBe(false);
			expect(fs.existsSync(parentPrefixSubagentEndpoint)).toBe(false);
			expect(fs.existsSync(agentTypeOnlySubagentEndpoint)).toBe(false);
			expect(fs.existsSync(explicitExtensionSubagentEndpoint)).toBe(false);
			expect(fs.existsSync(daemonPaths(cwd).roots)).toBe(false);
		} finally {
			await Promise.all(disposers.reverse().map(dispose => dispose()));
			if (previous === undefined) {
				delete process.env.GJC_NOTIFICATIONS;
			} else {
				process.env.GJC_NOTIFICATIONS = previous;
			}
			resetSettingsForTest();
		}
	}, 30000);

	test("sessionScope=primary keeps a canonical SDK endpoint while suppressing GJC-spawned child delivery", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-notif-spawned-"));
		tempDirs.push(cwd);
		const previousNotif = process.env.GJC_NOTIFICATIONS;
		const previousSpawn = process.env.GJC_SPAWNED_BY_SESSION;
		delete process.env.GJC_NOTIFICATIONS;
		delete process.env.GJC_SPAWNED_BY_SESSION;
		const adapterSettings = (scope: "all" | "primary"): Settings =>
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "discord-application",
				"notifications.discord.guildId": "discord-guild",
				"notifications.discord.parentChannelId": "discord-channel",
				"notifications.sessionScope": scope,
			});
		const primarySettings = adapterSettings("primary");
		const allSettings = adapterSettings("all");
		const disposers: Array<() => Promise<void>> = [];
		const spawn = async (settings: Settings) =>
			createAgentSession({
				cwd,
				agentDir: cwd,
				sessionManager: SessionManager.inMemory(cwd),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
		const endpointFor = (sessionId: string): string => path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		try {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, cwd, agentDir: cwd });

			// 1. A spawned child under primary keeps the mandatory SDK endpoint,
			// while the session-scoped delivery guard above suppresses notifications.
			process.env.GJC_SPAWNED_BY_SESSION = "parent-abc";
			const suppressed = await spawn(primarySettings);
			disposers.push(() => suppressed.session.dispose());
			expect(process.env.GJC_SPAWNED_BY_SESSION).toBeUndefined();

			// 2. Spawned child under the default "all" scope still registers.
			process.env.GJC_SPAWNED_BY_SESSION = "parent-abc";
			const preserved = await spawn(allSettings);
			disposers.push(() => preserved.session.dispose());

			// 3. Spawned child under primary WITH explicit opt-in keeps its endpoint.
			process.env.GJC_SPAWNED_BY_SESSION = "parent-abc";
			process.env.GJC_NOTIFICATIONS = "1";
			const optedIn = await spawn(primarySettings);
			disposers.push(() => optedIn.session.dispose());
			delete process.env.GJC_NOTIFICATIONS;

			await suppressed.session.extensionRunner?.emit({ type: "session_start" });
			await preserved.session.extensionRunner?.emit({ type: "session_start" });
			await optedIn.session.extensionRunner?.emit({ type: "session_start" });

			expect(fs.existsSync(endpointFor(suppressed.session.sessionId))).toBe(true);
			expect(fs.existsSync(endpointFor(preserved.session.sessionId))).toBe(true);
			expect(fs.existsSync(endpointFor(optedIn.session.sessionId))).toBe(true);
		} finally {
			await Promise.all(disposers.reverse().map(dispose => dispose()));
			if (previousNotif === undefined) delete process.env.GJC_NOTIFICATIONS;
			else process.env.GJC_NOTIFICATIONS = previousNotif;
			if (previousSpawn === undefined) delete process.env.GJC_SPAWNED_BY_SESSION;
			else process.env.GJC_SPAWNED_BY_SESSION = previousSpawn;
			resetSettingsForTest();
		}
	}, 30000);
	test("never-registered notifications extension captures no command or daemon artifacts", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notifications-unregistered-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notifications-agent-"));
		tempDirs.push(cwd, agentDir);
		const sessionId = "session-unregistered";
		let notify: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void } | undefined;
		const api = {
			registerCommand(
				name: string,
				command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void },
			) {
				if (name === "notify") notify = command;
			},
		} as unknown as ExtensionAPI;
		const extensionShouldRegister = shouldRegisterNotificationsExtension({ cfg: BASE_CFG, env: {} });

		expect(extensionShouldRegister).toBe(false);
		if (extensionShouldRegister) createNotificationsExtension(api);
		expect(notify).toBeUndefined();
		expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`))).toBe(false);
		expect(fs.existsSync(daemonPaths(agentDir).roots)).toBe(false);
	});
	test("captured /notify on uses the production daemon ensurer once and awaits SDK endpoint shutdown", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notifications-command-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notifications-agent-"));
		tempDirs.push(cwd, agentDir);
		const sessionId = "session-command";
		const settings = new Proxy(
			Settings.isolated({
				"notifications.enabled": false,
				"notifications.telegram.botToken": "123456:temporary-test-token",
				"notifications.telegram.chatId": "temporary-chat",
			}),
			{
				get(target, prop) {
					if (prop === "getAgentDir") return () => agentDir;
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			},
		) as Settings;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		let notify: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void } | undefined;
		let spawns = 0;
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			registerCommand(
				name: string,
				command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void },
			) {
				if (name === "notify") notify = command;
			},
		} as unknown as ExtensionAPI;
		const context = {
			cwd,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionName: () => "command harness",
			},
			ui: { notify: () => {} },
		} as unknown as ExtensionCommandContext;

		createNotificationsExtension(api, {
			settings,
			ensureTelegramDaemon: input =>
				ensureTelegramDaemonRunning(input, {
					pid: 4242,
					pidAlive: () => true,
					spawn: () => {
						spawns++;
						return { unref() {} };
					},
				}),
		});

		const endpoint = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		const roots = daemonPaths(agentDir).roots;
		const sessionStart = handlers.get("session_start");
		const sessionShutdown = handlers.get("session_shutdown");
		if (!sessionStart || !sessionShutdown || !notify)
			throw new Error("notifications extension did not register its command handlers");
		let shutdownCompleted = false;
		try {
			await sessionStart({}, context);
			expect(fs.existsSync(endpoint)).toBe(true);
			expect(fs.existsSync(roots)).toBe(false);

			settings.override("notifications.enabled", true);
			await notify.handler("on", context);
			expect(fs.existsSync(endpoint)).toBe(true);
			expect(fs.existsSync(roots)).toBe(true);
			const registeredRoots = JSON.parse(fs.readFileSync(roots, "utf8")) as { roots: string[] };
			expect(registeredRoots.roots).toEqual([path.join(cwd, ".gjc", "state")]);
			expect(spawns).toBe(1);

			await notify.handler("on", context);
			expect(fs.existsSync(endpoint)).toBe(true);
			expect((JSON.parse(fs.readFileSync(roots, "utf8")) as { roots: string[] }).roots).toEqual([
				path.join(cwd, ".gjc", "state"),
			]);
			expect(spawns).toBe(1);

			await sessionShutdown({}, context);
			shutdownCompleted = true;
			expect(fs.existsSync(endpoint)).toBe(false);
		} finally {
			if (!shutdownCompleted) await sessionShutdown({}, context);
		}
	}, 30000);

	test("maskToken handles unset tokens and never reveals the raw token", () => {
		expect(maskToken(undefined)).toBe("(unset)");
		expect(maskToken("")).toBe("(unset)");
		expect(maskToken("abc")).toBe("…(len 3)");
		expect(maskToken("abc")).not.toContain("abc");

		const token = "1234567890:super-secret-token";
		const masked = maskToken(token);
		expect(masked).toBe("1234…(len 29)");
		expect(masked).not.toContain(token);
	});

	test("tokenFingerprint is deterministic and not equal to the raw token", () => {
		const token = "1234567890:super-secret-token";
		const fingerprint = tokenFingerprint(token);
		expect(fingerprint).toBe(tokenFingerprint(token));
		expect(fingerprint).toMatch(/^[a-f0-9]{12}$/);
		expect(fingerprint).not.toBe(token);
	});

	test("sessionTag returns the last six characters", () => {
		expect(sessionTag("session-abcdef")).toBe("abcdef");
		expect(sessionTag("abc")).toBe("abc");
	});

	test("buildRedactedAction does NOT redact asks (they must stay answerable remotely)", () => {
		const action: RedactableAction = {
			id: "a1",
			kind: "ask",
			sessionId: "session-abcdef",
			question: "Deploy production?",
			options: ["Yes, deploy", "No, stop", "Custom"],
			summary: "Sensitive summary",
		};

		// Asks are exempt from redaction: question and options are preserved.
		expect(buildRedactedAction(action, { redact: true, sessionTag: "abcdef" })).toEqual(action);
	});

	test("buildRedactedAction returns unchanged action when redact is false", () => {
		const action: RedactableAction = {
			id: "a1",
			kind: "ask",
			sessionId: "session-abcdef",
			question: "Deploy production?",
			options: ["Yes", "No"],
			summary: "Sensitive summary",
		};

		expect(buildRedactedAction(action, { redact: false, sessionTag: "abcdef" })).toBe(action);
	});

	test("buildRedactedAction strips question and options for non-ask actions", () => {
		const action: RedactableAction = {
			id: "custom-1",
			kind: "custom",
			sessionId: "session-abcdef",
			question: "Sensitive question?",
			options: ["Sensitive option"],
			summary: "Sensitive summary",
		};

		expect(buildRedactedAction(action, { redact: true, sessionTag: "abcdef" })).toEqual({
			id: "custom-1",
			kind: "custom",
			sessionId: "session-abcdef",
		});
	});

	test("buildRedactedAction strips only summary for idle actions", () => {
		const action: RedactableAction = {
			id: "i1",
			kind: "idle",
			sessionId: "session-abcdef",
			summary: "Sensitive idle summary",
		};

		expect(buildRedactedAction(action, { redact: true, sessionTag: "abcdef" })).toEqual({
			id: "i1",
			kind: "idle",
			sessionId: "session-abcdef",
		});
	});
});
