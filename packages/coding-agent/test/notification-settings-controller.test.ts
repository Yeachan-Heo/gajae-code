import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CasReceipt } from "@gajae-code/coding-agent/config/atomic-yaml-patch";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type {
	NotificationsEditorOperations,
	NotificationsEditorPreferences,
	NotificationsEditorState,
	NotificationsMutationResult,
	NotificationsPreflightResult,
	NotificationsProviderSetupInput,
	PreparedNotificationProviderConfiguration,
} from "@gajae-code/coding-agent/modes/components/notifications-settings-editor";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import {
	createNotificationsEditorOperations,
	type NotificationsEditorAdapterContext,
	type NotificationsEditorOperationDependencies,
} from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import {
	getNotificationConfig,
	type NotificationProvider,
	type NotificationSettingsSnapshot,
} from "@gajae-code/coding-agent/sdk/bus/config";
import {
	createTelegramActivationMarker,
	telegramActivationIdentity,
} from "@gajae-code/coding-agent/sdk/bus/notification-orchestration";
import type {
	NotificationHealthReport,
	NotificationRecoveryReport,
	NotificationStatusReport,
} from "@gajae-code/coding-agent/sdk/bus/notification-service";
import type {
	NotificationSessionReconcileResult,
	NotificationSessionStatus,
} from "@gajae-code/coding-agent/sdk/bus/session-control";
import {
	readNotificationRootRegistration,
	registerNotificationRoot,
	withNotificationRootRegistryFence,
} from "@gajae-code/coding-agent/sdk/bus/telegram-daemon";

const TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";

function receipt(): CasReceipt {
	return {
		revisions: [],
		restore: async () => ({ status: "discarded" }),
		discard: () => {},
	} as unknown as CasReceipt;
}

function snapshot(overrides: Partial<NotificationSettingsSnapshot> = {}): NotificationSettingsSnapshot {
	return {
		enabled: true,
		telegram: {
			botToken: "stored-token",
			chatId: "stored-chat",
			sound: "important",
			rich: { enabled: true },
			btw: { enabled: true },
			richDraft: { enabled: false },
			toolActivity: { enabled: true },
			streaming: { enabled: true },
			topics: {},
		},
		discord: {},
		slack: {},
		redact: false,
		verbosity: "lean",
		sessionScope: "all",
		idleTimeoutMs: 60_000,
		...overrides,
	};
}

function health(): NotificationHealthReport {
	return {
		overall: "ok",
		configured: true,
		checks: [{ name: "config", level: "ok", detail: "healthy" }],
		daemon: {
			present: false,
			ownerId: undefined,
			pid: undefined,
			alive: false,
			heartbeatFresh: false,
			identityMatches: false,
			stopped: false,
			heartbeatAt: undefined,
			heartbeatAgeMs: undefined,
			generation: undefined,
			currentGeneration: 1,
			generationRelation: "unknown",
		},
		endpoints: { total: 0, live: 0, dead: 0, unknown: 0, unreadable: 0 },
		reachability: { probed: false, ok: false, detail: "not probed" },
	};
}

function recovery(): NotificationRecoveryReport {
	return {
		endpointsScanned: 0,
		endpointsRemoved: [],
		endpointsKept: 0,
		endpointsUnreadable: 0,
		daemon: { action: "none", detail: "no daemon", ownerId: undefined, pid: undefined },
	};
}

function adapterState(configured = false, channel?: string): NotificationStatusReport["discord"] {
	return {
		botTokenMasked: configured ? "••••" : "(unset)",
		channel,
		configured,
		quarantined: false,
		desiredEnabled: configured,
		desiredSource: "legacy",
		effectiveEnabled: configured,
		issues: [],
	};
}

function sessionStatus(): NotificationSessionStatus {
	return {
		eligible: true,
		locallyEnabled: true,
		genericSessionEnabled: true,
		genericEligibilitySource: "configured_provider",
		running: true,
	};
}

function sessionResult(status = sessionStatus()): NotificationSessionReconcileResult {
	return { outcome: "already", status };
}

function secret(value = TOKEN) {
	return { consume: vi.fn(() => value) };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(nextResolve => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function editorState(): NotificationsEditorState {
	return {
		status: {
			enabled: false,
			redact: false,
			verbosity: "lean",
			globallyConfigured: false,
			anyProviderComplete: false,
			anyProviderEffective: false,
			telegram: { ...adapterState(), tokenFingerprint: undefined },
			discord: adapterState(),
			slack: adapterState(),
		},
		session: sessionStatus(),
		preferences: {
			redact: false,
			verbosity: "lean",
			sessionScope: "all",
			richEnabled: true,
			richDraftEnabled: false,
			toolActivityEnabled: true,
			streamingEnabled: true,
			sound: "all",
		},
	};
}

function selectorOperations(
	input: {
		preflight?: (signal: AbortSignal) => Promise<NotificationsPreflightResult>;
		enableGlobally?: () => Promise<NotificationsMutationResult>;
		commitPreferences?: (preferences: NotificationsEditorPreferences) => Promise<NotificationsMutationResult>;
	} = {},
): NotificationsEditorOperations {
	return {
		loadState: async () => editorState(),
		refreshHealth: async () => health(),
		sendTest: async () => ({ ok: true, adapter: "telegram", chatId: "chat", detail: "delivered" }),
		recover: async () => recovery(),
		reconnect: async () => "attached",
		preflightProposedIdentity: async (_input, signal) =>
			await (input.preflight?.(signal) ??
				Promise.resolve({ status: "cancelled", identity: { status: "absent" }, message: "cancelled" })),
		commitConfigure: async () => ({ status: "saved", receipt: receipt(), message: "saved" }),
		saveInactive: async () => ({ status: "saved_inactive", receipt: receipt(), message: "saved" }),
		discardConfigureDraft: () => {},
		prepareProviderConfiguration: async (
			input: NotificationsProviderSetupInput,
		): Promise<PreparedNotificationProviderConfiguration> => {
			input.botToken.value?.consume();
			input.appToken?.value?.consume();
			return input.provider === "discord"
				? {
						provider: "discord",
						botTokenDisposition: input.botToken.action,
						botTokenMask: "••••",
						applicationId: input.applicationId ?? "application",
						guildId: input.guildId ?? "guild",
						parentChannelId: input.parentChannelId ?? "channel",
					}
				: {
						provider: "slack",
						botTokenDisposition: input.botToken.action,
						botTokenMask: "••••",
						appTokenDisposition: input.appToken?.action ?? "keep",
						appTokenMask: "••••",
						workspaceId: input.workspaceId ?? "workspace",
						channelId: input.channelId ?? "channel",
					};
		},
		commitProviderConfiguration: async () => ({ receipt: receipt(), message: "provider saved" }),
		discardProviderConfiguration: () => {},
		setProviderDesired: async (_provider: NotificationProvider, _enabled: boolean) => ({
			receipt: receipt(),
			message: "provider intent updated",
		}),
		removeProvider: async (_provider: NotificationProvider) => ({ receipt: receipt(), message: "provider removed" }),
		enableGlobally: async () => await (input.enableGlobally?.() ?? Promise.resolve({ message: "enabled" })),
		disableGlobally: async () => ({ message: "disabled" }),
		removeTelegram: async () => ({ message: "removed" }),
		setSessionLocal: async () => sessionResult(),
		commitPreferences: async preferences =>
			await (input.commitPreferences?.(preferences) ?? Promise.resolve({ message: "saved" })),
		reconcileCurrentSession: async () => sessionResult(),
	};
}

function selector(operations: NotificationsEditorOperations): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["red-claw"],
			availableModelProfiles: [],
			cwd: "/workspace",
		},
		{ onChange: () => {}, onCancel: () => {} },
		operations,
	);
}

function selectNotifications(component: SettingsSelectorComponent): void {
	// SETTING_TABS: appearance(0)…providers(8), notifications(9) — advance to the last tab.
	for (let index = 0; index < 9; index += 1) component.handleInput("\t");
}
function selectActionWithDescription(component: SettingsSelectorComponent, description: string): void {
	for (let index = 0; index < 20; index += 1) {
		if (component.render(120).join("\n").includes(description)) return;
		component.handleInput("\x1b[B");
	}
	throw new Error(`Could not select notification action: ${description}`);
}

function activateActionWithDescription(component: SettingsSelectorComponent, description: string): void {
	selectActionWithDescription(component, description);
	component.handleInput("\n");
}

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

describe("notification settings controller adapter", () => {
	it("maps editor operations to notification services, session control, and atomic commits", async () => {
		const staleIdentity = telegramActivationIdentity(TOKEN, "validated-chat");
		const staleMarker = createTelegramActivationMarker({
			botToken: TOKEN,
			chatId: "validated-chat",
			state: "inactive",
			reason: "saved_inactive",
			now: new Date("2026-07-12T00:00:00.000Z"),
		});
		const otherMarker = createTelegramActivationMarker({
			botToken: "other-token",
			chatId: "other-chat",
			state: "blocked",
			reason: "identity_mismatch",
			now: new Date("2026-07-12T00:00:00.000Z"),
		});
		let currentSnapshot = snapshot({
			enabled: false,
			telegram: {
				...snapshot().telegram,
				activation: {
					[staleIdentity]: staleMarker,
					[otherMarker.identity]: otherMarker,
				},
			},
		});
		const batches: unknown[][] = [];
		const events: string[] = [];
		const controller = {
			query: vi.fn(() => sessionStatus()),
			setLocalEnabled: vi.fn(async () => sessionResult()),
			reconcileCurrentSession: vi.fn(async () => sessionResult()),
			enterBlockedRuntime: vi.fn(async () => true),
			clearBlockedRuntime: vi.fn(async () => undefined),
		};
		const commitAtomicBatch = async (patches: unknown[]) => {
			events.push("commit");
			batches.push(structuredClone(patches));
			for (const patch of patches as Array<{ path?: string; value?: unknown }>) {
				if (patch.path === "notifications.telegram.toolActivity.enabled" && typeof patch.value === "boolean") {
					currentSnapshot.telegram.toolActivity.enabled = patch.value;
				}
			}
			return receipt();
		};
		const settings = {
			getAgentDir: () => "/tmp/gjc-settings-controller",
			getNotificationSettingsSnapshot: () => structuredClone(currentSnapshot),
			commitAtomicBatch,
			commitAtomicBatchWithCurrent: async (
				build: (current: Record<string, unknown>) => Promise<readonly unknown[]> | readonly unknown[],
			) =>
				await commitAtomicBatch([
					...(await build({ notifications: { telegram: { activation: currentSnapshot.telegram.activation } } })),
				]),
		} as unknown as Settings;
		let notifyFailure = false;
		const ctx = {
			settings,
			session: { notificationSessionController: controller },
			sessionManager: { getCwd: () => "/workspace/current", getSessionId: () => "session-current" },
			notifyConfigChanged: async () => {
				if (notifyFailure) throw new Error("observer failed");
				events.push("notify");
			},
		} as unknown as NotificationsEditorAdapterContext;
		const healthCalls: Array<Record<string, unknown>> = [];
		const setupCalls: Array<Record<string, unknown>> = [];
		const identityCalls: Array<Record<string, unknown>> = [];
		const serviceCalls: string[] = [];

		const dependencies: Partial<NotificationsEditorOperationDependencies> = {
			buildNotificationStatusReport: input => {
				serviceCalls.push("status");
				expect(input).toBe(settings);
				return editorState().status;
			},

			checkNotificationHealth: async input => {
				healthCalls.push(input as unknown as Record<string, unknown>);
				return health();
			},
			sendNotificationTest: async input => {
				serviceCalls.push("test");
				expect(input).toEqual(expect.objectContaining({ settings }));
				return { ok: true, adapter: "telegram", destination: "chat", detail: "delivered" };
			},
			recoverNotifications: async input => {
				serviceCalls.push("recover");
				expect(input).toMatchObject({ settings, stateRoot: path.join("/workspace/current", ".gjc", "state") });
				return recovery();
			},
			unregisterNotificationRoot: async () => ({ root: "/workspace/current/.gjc/state", remainingRoots: 1 }),
			stopTelegramDaemon: async input => {
				expect(input).toBe(settings);
				expect(getNotificationConfig(input).toolActivity.enabled).toBe(true);
				events.push("stop");
				return { ok: true, message: "stopped", before: { health: "running" } };
			},
			restartTelegramDaemon: async input => {
				expect(input).toBe(settings);
				expect(getNotificationConfig(input).toolActivity.enabled).toBe(false);
				events.push("reload");
				return { ok: true, message: "reloaded" };
			},
			reloadTelegramDaemon: async input => {
				expect(input).toBe(settings);
				expect(getNotificationConfig(input).toolActivity.enabled).toBe(false);
				events.push("reload");
				return { ok: true, message: "reloaded" };
			},

			ensureTelegramDaemonRunningDetailed: async input => {
				expect(input).toMatchObject({ cwd: "/workspace/current", sessionId: "session-current" });
				return "attached";
			},
			runTelegramSetup: async input => {
				setupCalls.push(input as unknown as Record<string, unknown>);
				const discovered = input.chatId === undefined;
				return {
					ok: true,
					chatId: discovered ? "discovered-chat" : "validated-chat",
					tokenFingerprint: "fingerprint",
					threadedMode: "enabled",
					threadedLabel: "verified",
					pairingSource: discovered ? "discovered" : "provided",
				};
			},
			proposedTelegramIdentity: async input => {
				identityCalls.push(input as unknown as Record<string, unknown>);
				return { status: "absent" };
			},
			reconcileCommittedTelegramConfiguration: async input => {
				events.push("reconcile");
				expect(input.activation.reconnect).toBeDefined();
				expect(input.inactiveMarkerToClear).toEqual(staleMarker);
				return { status: "activated", receipt: input.receipt, reconnect: "attached" };
			},
			providerRuntime: {
				activate: async provider => {
					events.push(`activate-${provider}`);
				},
				deactivate: async provider => {
					events.push(`deactivate-${provider}`);
				},
			},
		};
		const operations = createNotificationsEditorOperations(ctx, dependencies);

		const loaded = await operations.loadState();
		expect(loaded.session).toEqual(sessionStatus());
		expect(loaded.preferences.streamingEnabled).toBe(true);
		const signal = new AbortController().signal;
		await operations.refreshHealth({ probe: true, signal });
		await operations.sendTest();
		await operations.recover();
		await operations.reconnect();
		expect(controller.clearBlockedRuntime).toHaveBeenCalledWith(
			expect.objectContaining({ sessionManager: ctx.sessionManager }),
		);
		expect(controller.reconcileCurrentSession).toHaveBeenCalledWith(
			expect.objectContaining({ sessionManager: ctx.sessionManager }),
		);
		expect(healthCalls).toContainEqual(
			expect.objectContaining({ stateRoot: path.join("/workspace/current", ".gjc", "state"), probe: true, signal }),
		);
		expect(serviceCalls).toEqual(["status", "test", "recover"]);

		const firstSecret = secret();
		const firstPreflight = await operations.preflightProposedIdentity(
			{
				token: firstSecret as never,
				chatId: "input-chat",
				richEnabled: true,
				richDraftEnabled: false,
				streamingEnabled: true,
			},
			new AbortController().signal,
		);
		expect(firstSecret.consume).toHaveBeenCalledTimes(1);
		expect(firstPreflight).toMatchObject({
			status: "ready",
			draft: { chatId: "validated-chat", tokenMask: expect.not.stringContaining(TOKEN), streamingEnabled: true },
		});
		expect(setupCalls[0]).toMatchObject({ chatId: "input-chat", interactive: false });
		expect(identityCalls[0]).toMatchObject({ chatId: "validated-chat", chatDisplay: "validated-chat" });

		const discoveredPreflight = await operations.preflightProposedIdentity(
			{ token: secret() as never, richEnabled: true, richDraftEnabled: false, streamingEnabled: true },
			new AbortController().signal,
		);
		expect(setupCalls[1]).toMatchObject({ chatId: undefined, interactive: false });
		expect(discoveredPreflight).toMatchObject({
			status: "ready",
			pairingSource: "discovered",
			draft: { chatId: "discovered-chat" },
		});
		if (!discoveredPreflight.draft) throw new Error("Expected discovered setup draft.");
		operations.discardConfigureDraft(discoveredPreflight.draft);
		if (!firstPreflight.draft) throw new Error("Expected prepared Telegram draft.");
		await operations.commitConfigure(firstPreflight.draft);
		expect(batches[0]).toEqual([
			{ path: "notifications.enabled", op: "set", value: true },
			{ path: "notifications.telegram.botToken", op: "set", value: TOKEN },
			{ path: "notifications.telegram.chatId", op: "set", value: "validated-chat" },
			{ path: "notifications.telegram.enabled", op: "set", value: true },
			{ path: "notifications.telegram.rich.enabled", op: "set", value: true },
			{ path: "notifications.telegram.richDraft.enabled", op: "set", value: false },
			{ path: "notifications.telegram.streaming.enabled", op: "set", value: true },
		]);
		expect(events.slice(0, 3)).toEqual(["commit", "reconcile", "notify"]);

		const secondPreflight = await operations.preflightProposedIdentity(
			{
				token: secret() as never,
				chatId: "input-chat",
				richEnabled: true,
				richDraftEnabled: false,
				streamingEnabled: true,
			},
			new AbortController().signal,
		);
		if (!secondPreflight.draft) throw new Error("Expected prepared Telegram draft.");
		notifyFailure = true;
		const inactiveResult = await operations.saveInactive(secondPreflight.draft);
		expect(inactiveResult).toMatchObject({ status: "observer_failed", receipt: expect.anything() });
		notifyFailure = false;
		const inactiveIdentity = telegramActivationIdentity(TOKEN, "validated-chat");
		expect(batches[1]).toEqual([
			{ path: "notifications.telegram.botToken", op: "set", value: TOKEN },
			{ path: "notifications.telegram.chatId", op: "set", value: "validated-chat" },
			{ path: "notifications.telegram.enabled", op: "set", value: false },
			{
				path: "notifications.telegram.activation",
				op: "set",
				value: {
					[otherMarker.identity]: otherMarker,
					[inactiveIdentity]: {
						identity: inactiveIdentity,
						state: "inactive",
						reason: "saved_inactive",
						updatedAt: expect.any(String),
					},
				},
			},
		]);

		await operations.enableGlobally();
		await operations.disableGlobally();
		currentSnapshot = snapshot({
			discord: {
				botToken: "discord-token",
				applicationId: "discord-app",
				guildId: "discord-guild",
				parentChannelId: "discord-parent",
			},
		});
		const removed = await operations.removeTelegram();
		expect(removed.globallyDisabled).toBe(false);
		expect(batches.at(-1)).toEqual([
			{ path: "notifications.telegram.botToken", op: "unset" },
			{ path: "notifications.telegram.chatId", op: "unset" },
			{ path: "notifications.telegram.activation", op: "unset" },
			{ path: "notifications.telegram.enabled", op: "set", value: false },
		]);
		currentSnapshot = snapshot({
			slack: {
				botToken: "slack-token",
				appToken: "slack-app-token",
				workspaceId: "slack-workspace",
				channelId: "slack-channel",
			},
		});
		expect((await operations.removeTelegram()).globallyDisabled).toBe(false);
		expect(batches.at(-1)).toEqual([
			{ path: "notifications.telegram.botToken", op: "unset" },
			{ path: "notifications.telegram.chatId", op: "unset" },
			{ path: "notifications.telegram.activation", op: "unset" },
			{ path: "notifications.telegram.enabled", op: "set", value: false },
		]);
		currentSnapshot = snapshot({
			discord: {
				enabled: true,
				botToken: "discord-token",
				applicationId: "stored-app",
				guildId: "stored-guild",
				parentChannelId: "stored-parent",
			},
		});
		const providerDraft = await operations.prepareProviderConfiguration({
			provider: "discord",
			botToken: { action: "keep" },
			applicationId: "",
			guildId: "",
			parentChannelId: "",
		});
		expect(providerDraft).toMatchObject({
			provider: "discord",
			applicationIdDisplay: "stored-app",
			guildIdDisplay: "stored-guild",
			parentChannelIdDisplay: "stored-parent",
		});
		expect(Object.hasOwn(providerDraft, "applicationId")).toBe(false);
		expect(Object.hasOwn(providerDraft, "guildId")).toBe(false);
		expect(Object.hasOwn(providerDraft, "parentChannelId")).toBe(false);
		currentSnapshot.discord.applicationId = "concurrent-app";
		currentSnapshot.discord.guildId = "concurrent-guild";
		currentSnapshot.discord.parentChannelId = "concurrent-parent";
		await operations.commitProviderConfiguration(providerDraft);
		expect(batches.at(-1)).toEqual([
			{ path: "notifications.enabled", op: "set", value: true },
			{ path: "notifications.discord.enabled", op: "set", value: true },
		]);
		expect(events.slice(-2)).toEqual(["notify", "activate-discord"]);

		await operations.setSessionLocal(false);
		await operations.reconcileCurrentSession();
		expect(controller.setLocalEnabled).toHaveBeenCalledWith(
			expect.objectContaining({ sessionManager: ctx.sessionManager }),
			false,
		);
		expect(controller.reconcileCurrentSession).toHaveBeenCalledWith(
			expect.objectContaining({ sessionManager: ctx.sessionManager }),
		);
		events.length = 0;
		await operations.commitPreferences({
			redact: true,
			verbosity: "verbose",
			sessionScope: "primary",
			richEnabled: false,
			richDraftEnabled: true,
			toolActivityEnabled: false,
			streamingEnabled: false,
			sound: "none",
		});
		expect(batches.at(-1)).toEqual([
			{ path: "notifications.redact", op: "set", value: true },
			{ path: "notifications.verbosity", op: "set", value: "verbose" },
			{ path: "notifications.sessionScope", op: "set", value: "primary" },
			{ path: "notifications.telegram.sound", op: "set", value: "none" },
			{ path: "notifications.telegram.rich.enabled", op: "set", value: false },
			{ path: "notifications.telegram.richDraft.enabled", op: "set", value: true },
			{ path: "notifications.telegram.streaming.enabled", op: "set", value: false },
			{ path: "notifications.telegram.toolActivity.enabled", op: "set", value: false },
		]);
		expect(events).toEqual(["stop", "commit", "reload", "notify"]);

		const discarded = await operations.preflightProposedIdentity(
			{
				token: secret() as never,
				chatId: "input-chat",
				richEnabled: true,
				richDraftEnabled: false,
				streamingEnabled: true,
			},
			new AbortController().signal,
		);
		if (!discarded.draft) throw new Error("Expected prepared Telegram draft.");
		operations.discardConfigureDraft(discarded.draft);
		await expect(operations.commitConfigure(discarded.draft)).rejects.toThrow("draft expired");
	});

	it("restarts the fenced daemon when a tool activity disable commit fails", async () => {
		const events: string[] = [];
		const settings = {
			getAgentDir: () => "/tmp/gjc-settings-controller",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => {
				events.push("commit");
				throw new Error("commit failed");
			},
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: {},
				sessionManager: { getCwd: () => "/workspace/current", getSessionId: () => "session-current" },
			} as unknown as NotificationsEditorAdapterContext,
			{
				stopTelegramDaemon: async () => {
					events.push("stop");
					return { ok: true, message: "stopped", before: { health: "running" } };
				},
				restartTelegramDaemon: async input => {
					events.push("restart");
					expect(getNotificationConfig(input).toolActivity.enabled).toBe(true);
					return { ok: true, message: "restarted" };
				},
			},
		);

		await expect(
			operations.commitPreferences({
				redact: true,
				sound: "all",
				verbosity: "verbose",
				sessionScope: "primary",
				richEnabled: false,
				richDraftEnabled: true,
				toolActivityEnabled: false,
				streamingEnabled: true,
			}),
		).rejects.toThrow("commit failed");
		expect(events).toEqual(["stop", "commit", "restart"]);
		expect(getNotificationConfig(settings).toolActivity.enabled).toBe(true);
	});

	it("reports both commit and daemon restart failure after fencing", async () => {
		const settings = {
			getAgentDir: () => "/tmp/gjc-settings-controller",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => {
				throw new Error("commit failed");
			},
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: {},
				sessionManager: { getCwd: () => "/workspace/current", getSessionId: () => "session-current" },
			} as unknown as NotificationsEditorAdapterContext,
			{
				stopTelegramDaemon: async () => ({
					ok: true,
					message: "stopped",
					before: { health: "running" },
				}),
				restartTelegramDaemon: async () => ({ ok: false, message: "owner did not restart" }),
			},
		);

		await expect(
			operations.commitPreferences({
				redact: true,
				sound: "all",
				verbosity: "verbose",
				sessionScope: "primary",
				richEnabled: false,
				richDraftEnabled: true,
				toolActivityEnabled: false,
				streamingEnabled: true,
			}),
		).rejects.toThrow(
			"Notification preference commit failed (commit failed) and daemon restart failed (owner did not restart).",
		);
	});

	it("refuses generic Telegram desired-on while an exact activation marker remains", async () => {
		const marker = createTelegramActivationMarker({
			botToken: TOKEN,
			chatId: "stored-chat",
			state: "inactive",
			reason: "saved_inactive",
		});
		const currentSnapshot = snapshot({
			telegram: { ...snapshot().telegram, enabled: true, activation: { [marker.identity]: marker } },
		});
		let commits = 0;
		const settings = {
			getAgentDir: () => "/tmp/gjc-settings-controller-marker",
			getNotificationSettingsSnapshot: () => structuredClone(currentSnapshot),
			commitAtomicBatch: async () => {
				commits++;
				return receipt();
			},
			commitAtomicBatchWithCurrent: async () => receipt(),
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: {},
				sessionManager: { getCwd: () => "/workspace/current", getSessionId: () => "session-current" },
			} as unknown as NotificationsEditorAdapterContext,
			{ getCurrentTelegramActivationMarker: () => marker },
		);
		const result = await operations.setProviderDesired("telegram", true);
		expect(result).toMatchObject({ outcome: "failed" });
		expect(result.message).toContain("activation marker");
		expect(commits).toBe(0);
	});
	it("enters controller-owned blocked runtime before reporting a blocked committed identity", async () => {
		const events: string[] = [];
		const controller = {
			query: () => sessionStatus(),
			setLocalEnabled: async () => sessionResult(),
			reconcileCurrentSession: async () => sessionResult(),
			enterBlockedRuntime: async () => {
				events.push("enter-blocked");
				return true;
			},
			clearBlockedRuntime: async () => undefined,
		};
		const commitAtomicBatch = async () => {
			events.push("commit");
			return receipt();
		};
		const settings = {
			getAgentDir: () => "/tmp/gjc-settings-controller",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch,
			commitAtomicBatchWithCurrent: async (
				build: (current: Record<string, unknown>) => Promise<readonly unknown[]> | readonly unknown[],
			) => {
				await build({ notifications: { telegram: { activation: {} } } });
				return await commitAtomicBatch();
			},
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: controller },
				sessionManager: { getCwd: () => "/workspace/current", getSessionId: () => "session-current" },
				notifyConfigChanged: async () => {
					events.push("notify");
					throw new Error("observer failed");
				},
			} as unknown as NotificationsEditorAdapterContext,
			{
				runTelegramSetup: async () => ({
					ok: true,
					chatId: "validated-chat",
					tokenFingerprint: "fingerprint",
					threadedMode: "enabled",
					threadedLabel: "verified",
					pairingSource: "provided",
				}),
				proposedTelegramIdentity: async () => ({ status: "absent" }),
				ensureTelegramDaemonRunningDetailed: async () => {
					events.push("ensure");
					return "blocked_identity";
				},
			},
		);
		const result = await operations.preflightProposedIdentity(
			{
				token: secret() as never,
				chatId: "chat",
				richEnabled: true,
				richDraftEnabled: false,
				streamingEnabled: true,
			},
			new AbortController().signal,
		);
		if (!result.draft) throw new Error("Expected prepared Telegram draft.");
		const committed = await operations.commitConfigure(result.draft);
		expect(committed).toMatchObject({ status: "blocked_identity" });
		expect(committed.message).toContain("settings observer also failed");
		if (committed.status !== "blocked_identity") throw new Error("Expected blocked identity result.");
		expect(typeof committed.restore).toBe("function");
		expect(typeof committed.retainCommitted).toBe("function");
		expect(events).toEqual(["commit", "ensure", "enter-blocked", "commit", "notify"]);
	});
	it("removes the active tokenized production root and stops the last Telegram daemon", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-settings-remove-"));
		const cwd = path.join(agentDir, "workspace");
		const sessionId = "session-current";
		const currentSnapshot = snapshot();
		const events: string[] = [];
		const settings = {
			getAgentDir: () => agentDir,
			getNotificationSettingsSnapshot: () => structuredClone(currentSnapshot),
			commitAtomicBatch: async (patches: Array<{ path: string; op: string; value?: unknown }>) => {
				events.push("commit");
				for (const patch of patches) {
					if (patch.path === "notifications.telegram.botToken" && patch.op === "unset")
						currentSnapshot.telegram.botToken = undefined;
					if (patch.path === "notifications.telegram.chatId" && patch.op === "unset")
						currentSnapshot.telegram.chatId = undefined;
					if (patch.path === "notifications.enabled" && patch.op === "set")
						currentSnapshot.enabled = patch.value === true;
					if (patch.path === "notifications.telegram.enabled" && patch.op === "set")
						currentSnapshot.telegram.enabled = patch.value === true;
				}
				return receipt();
			},
		} as unknown as Settings;
		const controller = {
			query: () => sessionStatus(),
			setLocalEnabled: async () => sessionResult(),
			reconcileCurrentSession: async () => sessionResult(),
			enterBlockedRuntime: async () => {
				events.push("blocked");
				return true;
			},
			clearBlockedRuntime: async () => {
				events.push("cleared");
			},
		};
		try {
			const registration = await registerNotificationRoot({ settings, cwd, sessionId });
			expect(registration.token).toBeTruthy();
			const operations = createNotificationsEditorOperations(
				{
					settings,
					session: { notificationSessionController: controller },
					sessionManager: { getCwd: () => cwd, getSessionId: () => sessionId },
				} as unknown as NotificationsEditorAdapterContext,
				{
					stopTelegramDaemon: async input => {
						expect(input).toBe(settings);
						events.push("stop");
						return { ok: true, message: "stopped", before: { health: "running" } };
					},
				},
			);

			await operations.removeTelegram();

			expect(await readNotificationRootRegistration({ settings, sessionId })).toEqual({
				root: undefined,
				managed: false,
				token: undefined,
			});
			expect(events).toEqual(["blocked", "stop", "commit", "cleared"]);
			expect(currentSnapshot.enabled).toBe(true);
			expect(currentSnapshot.telegram.enabled).toBe(false);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
	it("does not stop a replacement tokenized root after a stale last-root observation", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-settings-remove-race-"));
		const cwd = path.join(agentDir, "workspace");
		const sessionId = "session-current";
		const events: string[] = [];
		const conditionalEntered = deferred<void>();
		const resumeConditional = deferred<void>();
		let stopCalls = 0;
		const settings = {
			getAgentDir: () => agentDir,
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => {
				events.push("commit");
				return receipt();
			},
		} as unknown as Settings;
		const controller = {
			query: () => sessionStatus(),
			setLocalEnabled: async () => sessionResult(),
			reconcileCurrentSession: async () => sessionResult(),
			enterBlockedRuntime: async () => {
				events.push("blocked");
				return true;
			},
			clearBlockedRuntime: async () => {
				events.push("cleared");
			},
		};
		try {
			const registration = await registerNotificationRoot({ settings, cwd, sessionId });
			const operations = createNotificationsEditorOperations(
				{
					settings,
					session: { notificationSessionController: controller },
					sessionManager: { getCwd: () => cwd, getSessionId: () => sessionId },
				} as unknown as NotificationsEditorAdapterContext,
				{
					stopTelegramDaemon: async () => {
						stopCalls += 1;
						return { ok: true, message: "stopped", before: { health: "running" } };
					},
					stopTelegramDaemonIfRootRegistryFenceMatches: async input => {
						conditionalEntered.resolve();
						await resumeConditional.promise;
						return await withNotificationRootRegistryFence({
							settings: input.settings,
							registryFingerprint: input.registryFingerprint,
							action: async () => {
								const stopped = await input.stop();
								if (!stopped.ok) throw new Error(stopped.message);
							},
						});
					},
				},
			);

			const removal = operations.removeTelegram();
			await conditionalEntered.promise;
			expect(await readNotificationRootRegistration({ settings, sessionId })).toEqual({
				root: undefined,
				managed: false,
				token: undefined,
			});
			const replacement = await registerNotificationRoot({ settings, cwd, sessionId });
			expect(replacement.token).not.toBe(registration.token);
			resumeConditional.resolve();
			await removal;

			expect(stopCalls).toBe(0);
			expect(await readNotificationRootRegistration({ settings, sessionId })).toEqual({
				root: path.join(cwd, ".gjc", "state"),
				managed: true,
				token: replacement.token,
			});
			expect(events).toEqual(["blocked", "commit", "cleared"]);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("notification settings selector lifecycle", () => {
	it("disposes a cancellable notification editor when switching tabs", async () => {
		const pairing = deferred<NotificationsPreflightResult>();
		let pairingSignal: AbortSignal | undefined;
		const component = selector(
			selectorOperations({
				preflight: signal => {
					pairingSignal = signal;
					return pairing.promise;
				},
			}),
		);
		selectNotifications(component);
		await flush();
		component.handleInput("\n"); // Configure
		component.handleInput("\n"); // select Telegram provider
		component.handleInput("\n"); // select Configure Telegram
		component.handleInput("12345"); // supplied private-chat ID -> validation path
		component.handleInput("\n");
		component.handleInput(TOKEN);
		component.handleInput("\n");
		expect(component.render(120).join("\n")).toContain("private-chat validation");
		component.handleInput("\t");
		expect(pairingSignal?.aborted).toBe(true);
		expect(component.render(120).join("\n")).not.toContain("private-chat validation");
		pairing.resolve({ status: "aborted", identity: { status: "absent" }, message: "cancelled" });
		await flush();
	});

	it("keeps the Notifications tab focused during a guarded action, including Escape", async () => {
		const gate = deferred<NotificationsMutationResult>();
		const component = selector(selectorOperations({ enableGlobally: () => gate.promise }));
		selectNotifications(component);
		await flush();
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\t");
		component.handleInput("\x1b");
		expect(component.render(120).join("\n")).toContain("Navigation is locked");
		gate.resolve({ message: "enabled" });
		await flush();
		component.dispose();
	});
	it("cycles and persists the Telegram sound preference", async () => {
		const commits: NotificationsEditorPreferences[] = [];
		const component = selector(
			selectorOperations({
				commitPreferences: async preferences => {
					commits.push(preferences);
					return { message: "saved" };
				},
			}),
		);
		selectNotifications(component);
		await flush();

		activateActionWithDescription(component, "Draft safe scalar preferences, then save them atomically.");
		selectActionWithDescription(component, "Cycle between all, important, and none notification sounds.");
		expect(component.render(120).join("\n")).toContain("Telegram notification sound: all");

		component.handleInput("\n");
		expect(component.render(120).join("\n")).toContain("Telegram notification sound: important");
		component.handleInput("\n");
		expect(component.render(120).join("\n")).toContain("Telegram notification sound: none");

		activateActionWithDescription(component, "Atomically persist this preference draft.");
		await flush();

		expect(commits).toHaveLength(1);
		expect(commits[0]?.sound).toBe("none");
	});
});
