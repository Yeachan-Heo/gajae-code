import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import {
	buildRedactedAction,
	getNotificationConfig,
	isGloballyConfigured,
	isSessionNotificationsEnabled,
	maskToken,
	type NotificationConfig,
	type RedactableAction,
	sessionTag,
	shouldRegisterNotificationsExtension,
	tokenFingerprint,
} from "../src/notifications/config";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";

const BASE_CFG: NotificationConfig = {
	enabled: false,
	botToken: undefined,
	chatId: undefined,
	discord: {
		botToken: undefined,
		channelId: undefined,
	},
	slack: {
		botToken: undefined,
		channelId: undefined,
	},
	redact: false,
	verbosity: "lean",
	idleTimeoutMs: 60000,
};

const GLOBAL_CFG: NotificationConfig = {
	...BASE_CFG,
	enabled: true,
	botToken: "1234567890:abc",
	chatId: "chat-1",
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
			"notifications.discord.channelId": "discord-channel",
			"notifications.slack.botToken": "slack-token",
			"notifications.slack.channelId": "slack-channel",
			"notifications.redact": true,
			"notifications.daemon.idleTimeoutMs": 1234,
		});

		expect(getNotificationConfig(settings)).toEqual({
			enabled: true,
			botToken: "token-1",
			chatId: "chat-1",
			discord: {
				botToken: "discord-token",
				channelId: "discord-channel",
			},
			slack: {
				botToken: "slack-token",
				channelId: "slack-channel",
			},
			redact: true,
			verbosity: "lean",
			idleTimeoutMs: 1234,
		});
	});

	test("isGloballyConfigured is true when enabled with any complete adapter", () => {
		expect(isGloballyConfigured(GLOBAL_CFG)).toBe(true);
		expect(isGloballyConfigured({ ...GLOBAL_CFG, enabled: false })).toBe(false);
		expect(isGloballyConfigured({ ...GLOBAL_CFG, botToken: undefined })).toBe(false);
		expect(isGloballyConfigured({ ...GLOBAL_CFG, botToken: "" })).toBe(false);
		expect(isGloballyConfigured({ ...GLOBAL_CFG, chatId: undefined })).toBe(false);
		expect(isGloballyConfigured({ ...GLOBAL_CFG, chatId: "" })).toBe(false);
		expect(
			isGloballyConfigured({
				...BASE_CFG,
				enabled: true,
				discord: { botToken: "discord-token", channelId: "discord-channel" },
			}),
		).toBe(true);
		expect(
			isGloballyConfigured({
				...BASE_CFG,
				enabled: true,
				slack: { botToken: "slack-token", channelId: "slack-channel" },
			}),
		).toBe(true);
		expect(
			isGloballyConfigured({
				...BASE_CFG,
				enabled: true,
				discord: { botToken: "discord-token", channelId: undefined },
			}),
		).toBe(false);
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
	});
	test("settings-enabled subagent sessions do not register the notifications extension", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notifications-subagent-"));
		tempDirs.push(cwd);
		const previous = process.env.GJC_NOTIFICATIONS;
		delete process.env.GJC_NOTIFICATIONS;
		const settings = Settings.isolated({
			"notifications.enabled": true,
			"notifications.discord.botToken": "discord-token",
			"notifications.discord.channelId": "discord-channel",
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
			await topLevel.session.extensionRunner?.emit({ type: "session_start" });
			await subagent.session.extensionRunner?.emit({ type: "session_start" });
			await parentPrefixSubagent.session.extensionRunner?.emit({ type: "session_start" });
			const topLevelEndpoint = path.join(
				cwd,
				".gjc",
				"state",
				"notifications",
				`${topLevel.session.sessionId}.json`,
			);
			const subagentEndpoint = path.join(
				cwd,
				".gjc",
				"state",
				"notifications",
				`${subagent.session.sessionId}.json`,
			);
			const parentPrefixSubagentEndpoint = path.join(
				cwd,
				".gjc",
				"state",
				"notifications",
				`${parentPrefixSubagent.session.sessionId}.json`,
			);
			expect(fs.existsSync(topLevelEndpoint)).toBe(true);
			expect(fs.existsSync(subagentEndpoint)).toBe(false);
			expect(fs.existsSync(parentPrefixSubagentEndpoint)).toBe(false);
		} finally {
			await Promise.all(disposers.reverse().map(dispose => dispose()));
			if (previous === undefined) {
				delete process.env.GJC_NOTIFICATIONS;
			} else {
				process.env.GJC_NOTIFICATIONS = previous;
			}
			resetSettingsForTest();
		}
	});

	test("maskToken handles unset tokens and never reveals the raw token", () => {
		expect(maskToken(undefined)).toBe("(unset)");
		expect(maskToken("")).toBe("(unset)");

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
