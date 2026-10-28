import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CasReceipt } from "@gajae-code/coding-agent/config/atomic-yaml-patch";
import { resetSettingsForTest, Settings, type SettingsAtomicPatch } from "@gajae-code/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import {
	getNotificationConfig,
	type NotificationProvider,
	type NotificationSettingsSnapshot,
	tokenFingerprint,
} from "@gajae-code/coding-agent/sdk/bus/config";
import {
	createTelegramActivationMarker,
	proposedTelegramIdentity,
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
import { DAEMON_GENERATION, DAEMON_VERSION, daemonPaths } from "@gajae-code/coding-agent/sdk/bus/telegram-daemon";
import {
	createNotificationsEditorOperations,
	type NotificationsEditorAdapterContext,
	type NotificationsEditorOperationDependencies,
} from "@gajae-code/coding-agent/sdk/notification-setup";
import type {
	NotificationsEditorOperations,
	NotificationsEditorPreferences,
	NotificationsEditorState,
	NotificationsMutationResult,
	NotificationsPreflightResult,
	NotificationsProviderSetupInput,
	PreparedNotificationProviderConfiguration,
} from "@gajae-code/coding-agent/sdk/notification-setup-contract";
import { TempDir } from "@gajae-code/utils";

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
			attachedEndpoints: undefined,
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
	it("rejects memory-only persistence and runtime work before consuming credentials", async () => {
		const settings = Settings.isolated();
		const before = structuredClone(settings.getNotificationSettingsSnapshot());
		const write = vi.spyOn(settings, "commitAtomicBatch");
		const writeCurrent = vi.spyOn(settings, "commitAtomicBatchWithCurrent");
		const notify = vi.fn();
		const reconnect = vi.fn();
		const setup = vi.fn();
		const controller = {
			setLocalEnabled: vi.fn(),
			reconcileCurrentSession: vi.fn(),
		};
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: controller },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
				notifyConfigChanged: notify,
			} as unknown as NotificationsEditorAdapterContext,
			{
				ensureTelegramDaemonRunningDetailed: reconnect as never,
				runTelegramSetup: setup as never,
			},
		);
		const token = secret();
		const providerToken = secret();
		const draft = {} as never;
		const actions = [
			() =>
				operations.preflightProposedIdentity(
					{ token, chatId: "chat", richEnabled: true, richDraftEnabled: false, streamingEnabled: true },
					new AbortController().signal,
				),
			() =>
				operations.prepareProviderConfiguration({
					provider: "discord",
					botToken: { action: "replace", value: providerToken },
				}),
			() => operations.commitConfigure(draft),
			() => operations.saveInactive(draft),
			() => operations.commitProviderConfiguration(draft),
			() => operations.setProviderDesired("telegram", true),
			() => operations.removeProvider("discord"),
			() => operations.enableGlobally(),
			() => operations.disableGlobally(),
			() => operations.removeTelegram(),
			() => operations.commitPreferences(editorState().preferences),
			() => operations.reconnect(),
			() => operations.recover(),
			() => operations.sendTest(),
			() => operations.setSessionLocal(true),
			() => operations.reconcileCurrentSession(),
		];
		for (const action of actions) await expect(action()).rejects.toThrow("writable durable settings");
		expect(token.consume).not.toHaveBeenCalled();
		expect(providerToken.consume).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(writeCurrent).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(reconnect).not.toHaveBeenCalled();
		expect(setup).not.toHaveBeenCalled();
		expect(controller.setLocalEnabled).not.toHaveBeenCalled();
		expect(controller.reconcileCurrentSession).not.toHaveBeenCalled();
		expect(settings.getNotificationSettingsSnapshot()).toEqual(before);
		write.mockRestore();
		writeCurrent.mockRestore();
		const withoutController = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: undefined },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
			} as NotificationsEditorAdapterContext,
			{ checkNotificationHealth: async () => health() },
		);
		expect((await withoutController.refreshHealth({ probe: false })).overall).toBe("ok");
		expect((await withoutController.setSessionLocal(true)).outcome).toBe("disabled");
		expect((await withoutController.reconcileCurrentSession()).outcome).toBe("disabled");
	});

	it("preserves provider draft authority when durability becomes unavailable", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notification-provider-"));
		try {
			const settings = await Settings.loadForScope({ cwd: dir, agentDir: dir });
			const runtime = { activate: vi.fn(async () => {}), deactivate: vi.fn(async () => {}) };
			const operations = createNotificationsEditorOperations(
				{
					settings,
					session: { notificationSessionController: undefined },
					sessionManager: { getCwd: () => dir, getSessionId: () => "session" },
				} as NotificationsEditorAdapterContext,
				{ providerRuntime: runtime },
			);
			const draft = await operations.prepareProviderConfiguration({
				provider: "discord",
				botToken: { action: "replace", value: secret() },
				applicationId: "app",
				guildId: "guild",
				parentChannelId: "channel",
			});
			const capability = vi.spyOn(settings, "canPersistDurableConfig").mockReturnValueOnce(false);
			await expect(operations.commitProviderConfiguration(draft)).rejects.toThrow("writable durable settings");
			capability.mockRestore();
			expect(runtime.activate).not.toHaveBeenCalled();
			const result = await operations.commitProviderConfiguration(draft);
			expect(result.outcome).toBe("success");
			expect(result.receipt).toBeDefined();
			const reopened = await Settings.loadForScope({ cwd: dir, agentDir: dir });
			expect(reopened.getNotificationSettingsSnapshot().discord.botToken).toBe(TOKEN);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		"success",
		"failed",
		"throw",
		"observer",
		"both",
		"fence",
	] as const)("saves inactive durably and handles session reconciliation: %s", async scenario => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notification-inactive-"));
		try {
			const settings = await Settings.loadForScope({ cwd: dir, agentDir: dir });
			const events: string[] = [];
			let sessionRunning = true;
			const controller = {
				reconcileCurrentSession: async () => {
					events.push("reconcile");
					expect(settings.getNotificationSettingsSnapshot().telegram.enabled).toBe(false);
					expect(settings.getNotificationSettingsSnapshot().telegram.botToken).toBe(TOKEN);
					if (scenario === "throw" || scenario === "both" || scenario === "fence") throw new Error(TOKEN);
					if (scenario === "failed") return { outcome: "failed", status: sessionStatus() };
					sessionRunning = false;
					return sessionResult({ ...sessionStatus(), running: false });
				},
				enterBlockedRuntime: async () => {
					events.push("fence");
					if (scenario === "fence") throw new Error(TOKEN);
					sessionRunning = false;
					return true;
				},
			};
			const operations = createNotificationsEditorOperations(
				{
					settings,
					session: { notificationSessionController: controller },
					sessionManager: { getCwd: () => dir, getSessionId: () => "session" },
					notifyConfigChanged: async () => {
						events.push("notify");
						if (scenario === "observer" || scenario === "both") throw new Error(TOKEN);
					},
				} as unknown as NotificationsEditorAdapterContext,
				{
					resolveTelegramSetupPreflight: async () => ({ status: "safe" }) as never,
					runTelegramSetup: async () => ({
						ok: true,
						chatId: "chat",
						tokenFingerprint: "fp",
						threadedMode: "enabled",
						threadedLabel: "verified",
						pairingSource: "provided",
					}),
					proposedTelegramIdentity: async () => ({ status: "foreign" }),
				},
			);
			const prepared = await operations.preflightProposedIdentity(
				{ token: secret(), chatId: "chat", richEnabled: true, richDraftEnabled: false, streamingEnabled: true },
				new AbortController().signal,
			);
			if (!prepared.draft) throw new Error("Missing draft");
			const capability = vi.spyOn(settings, "canPersistDurableConfig").mockReturnValueOnce(false);
			await expect(operations.saveInactive(prepared.draft)).rejects.toThrow("writable durable settings");
			capability.mockRestore();
			expect(events).toEqual([]);
			const result = await operations.saveInactive(prepared.draft);
			expect(result.status).toBe(
				scenario === "success"
					? "saved_inactive"
					: scenario === "observer"
						? "observer_failed"
						: "reconciliation_failed",
			);
			if (result.status === "unavailable") throw new Error("Missing receipt");
			expect(result.receipt).toBeDefined();
			expect(result.message).not.toContain(TOKEN);
			expect(sessionRunning).toBe(scenario === "fence");
			if (scenario === "fence") expect(result.message).toContain("runtime fencing failed");
			if (scenario === "both")
				expect(result.message).toContain("current-session reconciliation failed and settings observer failed");
			expect(events).toEqual(
				scenario === "failed" || scenario === "throw" || scenario === "both" || scenario === "fence"
					? ["reconcile", "fence", "notify"]
					: ["reconcile", "notify"],
			);
			const reopened = await Settings.loadForScope({ cwd: dir, agentDir: dir });
			expect(reopened.getNotificationSettingsSnapshot().telegram.botToken).toBe(TOKEN);
			expect(reopened.getNotificationSettingsSnapshot().telegram.enabled).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		"foreign",
		"unknown",
	] as const)("rejects %s activation without consuming the inactive draft", async identityStatus => {
		const commitAtomicBatch = vi.fn(async () => receipt());
		let inactivePatches: unknown;
		const commitAtomicBatchWithCurrent = vi.fn(async (build: (current: object) => unknown) => {
			inactivePatches = await build({ notifications: { telegram: {} } });
			return receipt();
		});
		const reconnect = vi.fn(async () => "attached" as const);
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch,
			commitAtomicBatchWithCurrent,
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: undefined },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
			},
			{
				resolveTelegramSetupPreflight: async () => ({ status: "safe" }) as never,
				runTelegramSetup: async () => ({
					ok: true,
					chatId: "chat",
					tokenFingerprint: "fp",
					threadedMode: "enabled",
					threadedLabel: "verified",
					pairingSource: "provided",
				}),
				proposedTelegramIdentity: async () => ({ status: identityStatus }),
				ensureTelegramDaemonRunningDetailed: reconnect,
			},
		);
		const result = await operations.preflightProposedIdentity(
			{ token: secret(), chatId: "chat", richEnabled: true, richDraftEnabled: false, streamingEnabled: true },
			new AbortController().signal,
		);
		if (!result.draft) throw new Error("Expected a prepared draft.");
		result.identity.status = "same";
		await expect(operations.commitConfigure({ ...result.draft })).rejects.toThrow("draft expired");
		await expect(operations.commitConfigure(result.draft)).rejects.toThrow("blocked");
		expect(commitAtomicBatch).not.toHaveBeenCalled();
		expect(commitAtomicBatchWithCurrent).not.toHaveBeenCalled();
		expect(reconnect).not.toHaveBeenCalled();
		expect(await operations.saveInactive(result.draft)).toMatchObject({ status: "saved_inactive" });
		expect(inactivePatches).toEqual(
			expect.arrayContaining([
				{ path: "notifications.telegram.enabled", op: "set", value: false },
				{ path: "notifications.telegram.botToken", op: "set", value: TOKEN },
			]),
		);
		await expect(operations.saveInactive(result.draft)).rejects.toThrow("draft expired");
		await expect(operations.commitConfigure(result.draft)).rejects.toThrow("draft expired");
		expect(commitAtomicBatchWithCurrent).toHaveBeenCalledTimes(1);
	});

	it.each(["foreign", "unknown"] as const)("revalidates a safe draft when identity becomes %s", async status => {
		let current: "same" | "foreign" | "unknown" = "same";
		const commitAtomicBatch = vi.fn(async () => receipt());
		const reconnect = vi.fn(async () => "attached" as const);
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch,
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: undefined },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
			},
			{
				resolveTelegramSetupPreflight: async () => ({ status: "safe" }) as never,
				runTelegramSetup: async () => ({
					ok: true,
					chatId: "chat",
					tokenFingerprint: "fp",
					threadedMode: "enabled",
					threadedLabel: "verified",
					pairingSource: "provided",
				}),
				proposedTelegramIdentity: async () => ({ status: current }),
				ensureTelegramDaemonRunningDetailed: reconnect,
			},
		);
		const result = await operations.preflightProposedIdentity(
			{ token: secret(), chatId: "chat", richEnabled: true, richDraftEnabled: false, streamingEnabled: true },
			new AbortController().signal,
		);
		if (!result.draft) throw new Error("Expected a prepared draft.");
		current = status;
		await expect(operations.commitConfigure(result.draft)).rejects.toThrow("blocked");
		expect(commitAtomicBatch).not.toHaveBeenCalled();
		expect(reconnect).not.toHaveBeenCalled();
		operations.discardConfigureDraft(result.draft);
		await expect(operations.commitConfigure(result.draft)).rejects.toThrow("draft expired");
	});

	it("blocks a direct SDK commit when a live owner incarnation becomes unverifiable", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-settings-identity-"));
		try {
			const paths = daemonPaths(agentDir);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					pid: 44_444,
					incarnation: "linux:44444",
					ownerId: "owner",
					tokenFingerprint: tokenFingerprint(TOKEN),
					chatId: "chat",
					startedAt: 1,
					heartbeatAt: 1,
					roots: [],
					version: DAEMON_VERSION,
					generation: DAEMON_GENERATION,
				}),
			);
			let incarnation: string | undefined = "linux:44444";
			const commitAtomicBatch = vi.fn(async () => receipt());
			const commitAtomicBatchWithCurrent = vi.fn(async () => receipt());
			const reconnect = vi.fn(async () => "attached" as const);
			const settings = {
				canPersistDurableConfig: () => true,
				getAgentDir: () => agentDir,
				getNotificationSettingsSnapshot: () => snapshot(),
				commitAtomicBatch,
				commitAtomicBatchWithCurrent,
			} as unknown as Settings;
			const operations = createNotificationsEditorOperations(
				{
					settings,
					session: { notificationSessionController: undefined },
					sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
				},
				{
					resolveTelegramSetupPreflight: async () => ({ status: "safe" }) as never,
					runTelegramSetup: async () => ({
						ok: true,
						chatId: "chat",
						tokenFingerprint: tokenFingerprint(TOKEN),
						threadedMode: "enabled",
						threadedLabel: "verified",
						pairingSource: "provided",
					}),
					proposedTelegramIdentity: input =>
						proposedTelegramIdentity({
							...input,
							deps: { pidAlive: () => true, pidIncarnation: () => incarnation },
						}),
					ensureTelegramDaemonRunningDetailed: reconnect,
				},
			);
			const preflight = await operations.preflightProposedIdentity(
				{ token: secret(), chatId: "chat", richEnabled: true, richDraftEnabled: false, streamingEnabled: true },
				new AbortController().signal,
			);
			expect(preflight.identity.status).toBe("same");
			if (!preflight.draft) throw new Error("Expected a prepared draft.");
			incarnation = undefined;
			let message = "";
			try {
				await operations.commitConfigure(preflight.draft);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain("blocked");
			expect(message).not.toContain(TOKEN);
			expect(message).not.toContain(tokenFingerprint(TOKEN));
			expect(commitAtomicBatch).not.toHaveBeenCalled();
			expect(commitAtomicBatchWithCurrent).not.toHaveBeenCalled();
			expect(reconnect).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("does not consume a draft twice or commit after discard during identity revalidation", async () => {
		const gate = deferred<{ status: "same" }>();
		let calls = 0;
		const commitAtomicBatch = vi.fn(async () => receipt());
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch,
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: undefined },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
			},
			{
				resolveTelegramSetupPreflight: async () => ({ status: "safe" }) as never,
				runTelegramSetup: async () => ({
					ok: true,
					chatId: "chat",
					tokenFingerprint: "fp",
					threadedMode: "enabled",
					threadedLabel: "verified",
					pairingSource: "provided",
				}),
				proposedTelegramIdentity: async () => (++calls === 1 ? { status: "same" } : await gate.promise),
			},
		);
		const preflight = await operations.preflightProposedIdentity(
			{ token: secret(), chatId: "chat", richEnabled: true, richDraftEnabled: false, streamingEnabled: true },
			new AbortController().signal,
		);
		if (!preflight.draft) throw new Error("Expected a prepared draft.");
		const pending = operations.commitConfigure(preflight.draft);
		await expect(operations.commitConfigure(preflight.draft)).rejects.toThrow("draft expired");
		await expect(operations.saveInactive(preflight.draft)).rejects.toThrow("draft expired");
		operations.discardConfigureDraft(preflight.draft);
		gate.resolve({ status: "same" });
		await expect(pending).rejects.toThrow("draft expired");
		expect(commitAtomicBatch).not.toHaveBeenCalled();
	});

	it.each([
		"restored",
		"still_blocked",
		"marker_restore_failure",
	] as const)("preserves %s restore and classifies a subsequent observer failure", async outcome => {
		const initial = snapshot();
		const current = structuredClone(initial);
		const parentAt = (keys: readonly string[]): Record<string, unknown> => {
			let target = current as unknown as Record<string, unknown>;
			for (const key of keys.slice(0, -1)) {
				const child = target[key];
				if (!child || typeof child !== "object" || Array.isArray(child)) target[key] = {};
				target = target[key] as Record<string, unknown>;
			}
			return target;
		};
		let commits = 0;
		const commit = async (patches: readonly { path: string; op: string; value?: unknown }[]) => {
			const commitNumber = ++commits;
			const previous = patches.map(patch => {
				const keys = patch.path.split(".").slice(1);
				const target = parentAt(keys);
				const key = keys[keys.length - 1]!;
				const value = structuredClone(target[key]);
				if (patch.op === "unset") delete target[key];
				else target[key] = structuredClone(patch.value);
				return { keys, value };
			});
			return {
				revisions: [],
				discard: () => {},
				restore: async () => {
					if (commitNumber === 2 && outcome === "marker_restore_failure") throw new Error(TOKEN);
					for (const { keys, value } of previous) {
						const target = parentAt(keys);
						const key = keys[keys.length - 1]!;
						if (value === undefined) delete target[key];
						else target[key] = value;
					}
					return { status: "restored" as const, receipt: receipt() };
				},
			};
		};
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () => structuredClone(current),
			commitAtomicBatch: commit,
			commitAtomicBatchWithCurrent: async (
				build: (raw: object) => Promise<readonly SettingsAtomicPatch[]> | readonly SettingsAtomicPatch[],
			) => commit(await build({ notifications: current })),
		} as unknown as Settings;
		let notifications = 0;
		let reconnects = 0;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: undefined },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
				notifyConfigChanged: () => {
					if (++notifications === 2) throw new Error(TOKEN);
				},
			},
			{
				resolveTelegramSetupPreflight: async () => ({ status: "safe" }) as never,
				runTelegramSetup: async () => ({
					ok: true,
					chatId: "chat",
					tokenFingerprint: "fp",
					threadedMode: "enabled",
					threadedLabel: "verified",
					pairingSource: "provided",
				}),
				proposedTelegramIdentity: async () => ({ status: "same" }),
				ensureTelegramDaemonRunningDetailed: async () =>
					++reconnects === 1 || outcome === "still_blocked" ? "blocked_identity" : "attached",
			},
		);
		const preflight = await operations.preflightProposedIdentity(
			{ token: secret(), chatId: "chat", richEnabled: true, richDraftEnabled: false, streamingEnabled: true },
			new AbortController().signal,
		);
		if (!preflight.draft) throw new Error("Expected a prepared draft.");
		const committed = await operations.commitConfigure(preflight.draft);
		if (committed.status !== "blocked_identity") throw new Error("Expected blocked activation.");
		expect(current.telegram.botToken).toBe(TOKEN);
		expect(Object.values(current.telegram.activation ?? {})).toHaveLength(1);
		const restored = await committed.restore();
		expect(restored).toMatchObject({
			status: outcome === "marker_restore_failure" ? "restored" : outcome,
			observerFailed: true,
			...(outcome === "marker_restore_failure" ? { markerRestoreFailed: true, runtimeFenced: true } : {}),
		});
		if (restored.status !== "restored" && restored.status !== "still_blocked")
			throw new Error("Unexpected restore outcome.");
		expect(restored.observerFailed).toBe(true);
		expect(JSON.stringify(restored)).not.toContain(TOKEN);
		expect(current.telegram.botToken).toBe(initial.telegram.botToken);
		expect(current.telegram.chatId).toBe(initial.telegram.chatId);
		expect(Object.values(current.telegram.activation ?? {})).toHaveLength(
			outcome === "marker_restore_failure" ? 1 : 0,
		);
		expect(notifications).toBe(2);
	});
	it("propagates an actual restore failure without calling the observer again", async () => {
		const notify = vi.fn(async () => {});
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => receipt(),
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: undefined },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
				notifyConfigChanged: notify,
			},
			{
				resolveTelegramSetupPreflight: async () => ({ status: "safe" }) as never,
				runTelegramSetup: async () => ({
					ok: true,
					chatId: "chat",
					tokenFingerprint: "fp",
					threadedMode: "enabled",
					threadedLabel: "verified",
					pairingSource: "provided",
				}),
				proposedTelegramIdentity: async () => ({ status: "same" }),
				reconcileCommittedTelegramConfiguration: async input => ({
					status: "blocked_identity",
					receipt: input.receipt,
					message: "blocked",
					retainCommitted: () => {},
					restore: async () => {
						throw new Error("restore failed");
					},
				}),
			},
		);
		const preflight = await operations.preflightProposedIdentity(
			{ token: secret(), chatId: "chat", richEnabled: true, richDraftEnabled: false, streamingEnabled: true },
			new AbortController().signal,
		);
		if (!preflight.draft) throw new Error("Expected a prepared draft.");
		const committed = await operations.commitConfigure(preflight.draft);
		if (committed.status !== "blocked_identity") throw new Error("Expected blocked activation.");
		await expect(committed.restore()).rejects.toThrow("restore failed");
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("rejects forged, foreign, discarded, and replayed provider drafts without side effects", async () => {
		const commitAtomicBatch = vi.fn(async () => receipt());
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () =>
				snapshot({
					discord: {
						botToken: "stored-secret",
						applicationId: "app",
						guildId: "guild",
						parentChannelId: "parent",
					},
				}),
			commitAtomicBatch,
		} as unknown as Settings;
		const activate = vi.fn(async () => {});
		const deactivate = vi.fn(async () => {});
		const notifyConfigChanged = vi.fn(async () => {});
		const ctx: NotificationsEditorAdapterContext = {
			settings,
			session: {} as NotificationsEditorAdapterContext["session"],
			sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
			notifyConfigChanged,
		};
		const deps = { providerRuntime: { activate, deactivate } };
		const operations = createNotificationsEditorOperations(ctx, deps);
		const other = createNotificationsEditorOperations(ctx, deps);
		const input: NotificationsProviderSetupInput = {
			provider: "discord",
			botToken: { action: "keep" },
			parentChannelId: "prepared-parent",
		};
		const foreign = await other.prepareProviderConfiguration(input);
		const discarded = await operations.prepareProviderConfiguration(input);
		operations.discardProviderConfiguration(discarded);
		const prepared = await operations.prepareProviderConfiguration(input);
		expect(Reflect.set(prepared, "parentChannelId", "forged-parent")).toBe(false);
		for (const draft of [
			{
				provider: "discord",
				botTokenDisposition: "keep",
				botTokenMask: "unset",
				parentChannelId: "forged-destination",
			} as const,
			{
				provider: "slack",
				botTokenDisposition: "keep",
				botTokenMask: "unset",
				channelId: "forged-destination",
			} as const,
			foreign,
			discarded,
			{ ...prepared },
		]) {
			expect(await operations.commitProviderConfiguration(draft)).toMatchObject({
				outcome: "failed",
				code: "invalid_draft",
			});
		}
		expect(commitAtomicBatch).not.toHaveBeenCalled();
		expect(activate).not.toHaveBeenCalled();
		expect(deactivate).not.toHaveBeenCalled();
		expect(notifyConfigChanged).not.toHaveBeenCalled();
		const [committed, concurrent] = await Promise.all([
			operations.commitProviderConfiguration(prepared),
			operations.commitProviderConfiguration(prepared),
		]);
		expect(committed.outcome).toBe("success");
		expect(concurrent).toMatchObject({ outcome: "failed", code: "invalid_draft" });
		expect(commitAtomicBatch).toHaveBeenCalledTimes(1);
		expect(activate).toHaveBeenCalledTimes(1);
		expect(await operations.commitProviderConfiguration(prepared)).toMatchObject({
			outcome: "failed",
			code: "invalid_draft",
		});
		expect(commitAtomicBatch).toHaveBeenCalledTimes(1);
		expect(activate).toHaveBeenCalledTimes(1);
		other.discardProviderConfiguration(foreign);
	});
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
			canPersistDurableConfig: () => true,
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
				expect(input).toEqual({ settings: ctx.settings });
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
		const firstCommit = operations.commitConfigure(firstPreflight.draft);
		await Promise.all([
			expect(operations.commitConfigure(firstPreflight.draft)).rejects.toThrow("draft expired"),
			expect(operations.saveInactive(firstPreflight.draft)).rejects.toThrow("draft expired"),
		]);
		await firstCommit;
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
		const inactiveCommit = operations.saveInactive(secondPreflight.draft);
		await Promise.all([
			expect(operations.saveInactive(secondPreflight.draft)).rejects.toThrow("draft expired"),
			expect(operations.commitConfigure(secondPreflight.draft)).rejects.toThrow("draft expired"),
		]);
		const inactiveResult = await inactiveCommit;
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
			canPersistDurableConfig: () => true,
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
				session: { notificationSessionController: undefined },
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
			canPersistDurableConfig: () => true,
			getAgentDir: () => "/tmp/gjc-settings-controller",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => {
				throw new Error("commit failed");
			},
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: undefined },
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
			canPersistDurableConfig: () => true,
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
				session: { notificationSessionController: undefined },
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
			canPersistDurableConfig: () => true,
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
	it.each([
		"primary",
		"marker",
	] as const)("notifies observers only after a restored primary receipt when %s is not restorable", async target => {
		let notifications = 0;
		const primary = {
			...receipt(),
			restore: async () =>
				target === "primary"
					? { status: "not-restorable" as const }
					: { status: "restored" as const, receipt: receipt() },
		};
		const marker = { ...receipt(), restore: async () => ({ status: "not-restorable" as const }) };
		const settings = {
			canPersistDurableConfig: () => true,
			getAgentDir: () => "/unused",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => primary,
			commitAtomicBatchWithCurrent: async () => marker,
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: undefined },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
				notifyConfigChanged: () => {
					notifications++;
				},
			} as unknown as NotificationsEditorAdapterContext,
			{
				resolveTelegramSetupPreflight: async () => ({ status: "safe" }) as never,
				runTelegramSetup: async () => ({
					ok: true,
					chatId: "chat",
					tokenFingerprint: "fp",
					threadedMode: "enabled",
					threadedLabel: "verified",
					pairingSource: "provided",
				}),
				proposedTelegramIdentity: async () => ({ status: "same" }),
				ensureTelegramDaemonRunningDetailed: async () => "blocked_identity",
			},
		);
		const prepared = await operations.preflightProposedIdentity(
			{ token: secret(), chatId: "chat", richEnabled: true, richDraftEnabled: false, streamingEnabled: true },
			new AbortController().signal,
		);
		if (!prepared.draft) throw new Error("Expected draft.");
		const committed = await operations.commitConfigure(prepared.draft);
		if (committed.status !== "blocked_identity") throw new Error("Expected blocked commit.");
		expect(notifications).toBe(1);
		const restored = await committed.restore();
		expect(restored.status).toBe(target === "primary" ? "not-restorable" : "restored");
		expect(notifications).toBe(target === "primary" ? 1 : 2);
	});

	it.each([
		"activate",
		"deactivate",
		"reconnect",
		"remove",
	] as const)("reports resolved reconciliation failure for %s", async action => {
		const events: string[] = [];
		const committed = receipt();
		const settings = {
			canPersistDurableConfig: () => true,
			getAgentDir: () => "/unused",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => {
				events.push("commit");
				return committed;
			},
		} as unknown as Settings;
		const controller = {
			reconcileCurrentSession: async () => {
				events.push("reconcile");
				return { outcome: "failed" as const, status: sessionStatus() };
			},
			clearBlockedRuntime: async () => {
				events.push("clear");
			},
			enterBlockedRuntime: async () => {
				events.push("fence");
				return true;
			},
		};
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: controller },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
				notifyConfigChanged: () => {
					events.push("notify");
				},
			} as unknown as NotificationsEditorAdapterContext,
			{
				ensureTelegramDaemonRunningDetailed: async () => "attached",
				stopTelegramDaemon: async () => ({ ok: true, message: "stopped" }),
				getCurrentTelegramActivationMarker: () => undefined,
			},
		);
		if (action === "reconnect") {
			await expect(operations.reconnect()).rejects.toThrow("reconciliation failed; runtime was fenced");
			expect(events).toEqual(["clear", "reconcile", "fence"]);
		} else {
			const result =
				action === "remove"
					? await operations.removeTelegram()
					: await operations.setProviderDesired("telegram", action === "activate");
			expect(result).toMatchObject({ receipt: committed, outcome: "degraded" });
			expect(events).toContain("notify");
			expect(result.message).toContain(
				action === "remove"
					? "reconciliation failed"
					: `${action === "activate" ? "activation" : "deactivation"} failed`,
			);
			if (action === "remove") expect(events).toEqual(["fence", "commit", "clear", "reconcile", "fence", "notify"]);
		}
	});

	it.each([
		"blocked",
		"reconcile",
		"remove-before",
		"remove-after",
	] as const)("reports a false fencing result for %s", async action => {
		const events: string[] = [];
		const committed = receipt();
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => {
				events.push("commit");
				return committed;
			},
		} as unknown as Settings;
		let fences = 0;
		const controller = {
			clearBlockedRuntime: async () => {},
			reconcileCurrentSession: async () => ({ outcome: "failed" as const, status: sessionStatus() }),
			enterBlockedRuntime: async () => {
				events.push("fence");
				return action === "remove-after" && ++fences === 1;
			},
		};
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: controller },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
				notifyConfigChanged: () => {
					events.push("notify");
				},
			} as unknown as NotificationsEditorAdapterContext,
			{
				ensureTelegramDaemonRunningDetailed: async () => (action === "blocked" ? "blocked_identity" : "attached"),
				stopTelegramDaemon: async () => {
					events.push("stop");
					return { ok: true, message: "stopped" };
				},
			},
		);
		if (action === "blocked" || action === "reconcile") {
			await expect(operations.reconnect()).rejects.toThrow("could not be fenced");
		} else if (action === "remove-before") {
			await expect(operations.removeTelegram()).rejects.toThrow("could not be fenced");
			expect(events).toEqual(["fence"]);
		} else {
			const result = await operations.removeTelegram();
			expect(result).toMatchObject({ outcome: "degraded", receipt: committed });
			expect(result.message).toContain("current runtime could not be fenced");
			expect(events).toEqual(["fence", "stop", "commit", "fence", "notify"]);
		}
	});

	it("reports false fencing when reconciliation fails during removal recovery", async () => {
		const events: string[] = [];
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => {
				throw new Error("commit failed");
			},
		} as unknown as Settings;
		let fences = 0;
		const controller = {
			enterBlockedRuntime: async () => {
				events.push("fence");
				return ++fences === 1;
			},
			clearBlockedRuntime: async () => {
				events.push("clear");
			},
			reconcileCurrentSession: async () => ({ outcome: "failed" as const, status: sessionStatus() }),
		};
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: controller },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
			} as unknown as NotificationsEditorAdapterContext,
			{
				stopTelegramDaemon: async () => ({ ok: true, message: "stopped" }),
				ensureTelegramDaemonRunningDetailed: async () => "attached",
			},
		);
		await expect(operations.removeTelegram()).rejects.toThrow("runtime could not be fenced");
		expect(events).toEqual(["fence", "clear", "fence"]);
	});

	it("reports unsuccessful fencing after a failed reconnect reconciliation", async () => {
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () => snapshot(),
		} as unknown as Settings;
		const controller = {
			clearBlockedRuntime: async () => {},
			reconcileCurrentSession: async () => ({ outcome: "failed" as const, status: sessionStatus() }),
			enterBlockedRuntime: async () => {
				throw new Error(TOKEN);
			},
		};
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: controller },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
			} as unknown as NotificationsEditorAdapterContext,
			{ ensureTelegramDaemonRunningDetailed: async () => "attached" },
		);
		await expect(operations.reconnect()).rejects.toThrow("runtime could not be fenced");
	});

	it("redacts provider secrets in a post-commit daemon reload diagnostic", async () => {
		const secrets = ["old-telegram-secret", "discord-secret", "discord-secret-longer", "slack-app-secret"];
		const sensitive = [...secrets, ...secrets.map(tokenFingerprint)];
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () =>
				snapshot({
					telegram: { ...snapshot().telegram, enabled: true, botToken: secrets[0], chatId: "chat" },
					discord: { botToken: secrets[1] },
					slack: { botToken: secrets[2], appToken: secrets[3] },
				}),
			commitAtomicBatch: async () => receipt(),
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: undefined },
				sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
			} as unknown as NotificationsEditorAdapterContext,
			{
				reloadTelegramDaemon: async () => ({ ok: false, message: `failure ${sensitive.join(" ")}` }),
			},
		);
		const result = await operations.commitPreferences({ ...editorState().preferences, toolActivityEnabled: true });
		expect(result.outcome).toBe("degraded");
		expect(result.message).toContain("daemon reload failed");
		for (const secret of sensitive) expect(result.message).not.toContain(secret);
	});

	it("sanitizes injected health, test and recovery details and errors across providers", async () => {
		const secrets = [TOKEN, "shared-secret", "shared-secret-longer", "slack-app-secret"];
		const sensitive = [...secrets, ...secrets.map(tokenFingerprint)];
		const detail = `diagnostic ${sensitive.join(" ")}`;
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () =>
				snapshot({
					telegram: { ...snapshot().telegram, botToken: secrets[0] },
					discord: { botToken: secrets[1] },
					slack: { botToken: secrets[2], appToken: secrets[3] },
				}),
		} as unknown as Settings;
		const context = {
			settings,
			session: { notificationSessionController: undefined },
			sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
		} as unknown as NotificationsEditorAdapterContext;
		const operations = createNotificationsEditorOperations(context, {
			checkNotificationHealth: async () => ({
				...health(),
				checks: [{ name: "config", level: "ok", detail }],
				reachability: { probed: true, ok: true, detail },
			}),
			sendNotificationTest: async () => ({ ok: true, adapter: "discord", detail }),
			recoverNotifications: async () => ({ ...recovery(), daemon: { ...recovery().daemon, detail } }),
		});
		const report = await operations.refreshHealth({ probe: true });
		const outputs = [
			report.checks[0].detail,
			report.reachability.detail,
			(await operations.sendTest()).detail,
			(await operations.recover()).daemon.detail,
		];
		for (const output of outputs) {
			expect(output).toContain("diagnostic");
			for (const secret of sensitive) expect(output).not.toContain(secret);
		}
		const failing = createNotificationsEditorOperations(context, {
			checkNotificationHealth: async () => {
				throw new Error(detail);
			},
			sendNotificationTest: async () => {
				throw new Error(detail);
			},
		});
		for (const call of [() => failing.refreshHealth({ probe: true }), () => failing.sendTest()]) {
			try {
				await call();
				throw new Error("Expected diagnostic failure");
			} catch (error) {
				expect((error as Error).message).toContain("diagnostic");
				for (const secret of sensitive) expect((error as Error).message).not.toContain(secret);
			}
		}
		const getterFailure = createNotificationsEditorOperations(context, {
			getNotificationConfig: () => {
				throw new Error(detail);
			},
			checkNotificationHealth: async () => {
				throw new Error(detail);
			},
		});
		await expect(getterFailure.refreshHealth({ probe: true })).rejects.toThrow(
			"Notification diagnostic unavailable.",
		);
	});

	it("redacts persisted daemon metadata at the SDK boundary", async () => {
		const secrets = [TOKEN, "shared-secret"];
		const sensitive = [...secrets, ...secrets.map(tokenFingerprint)];
		const settings = {
			canPersistDurableConfig: () => true,
			getNotificationSettingsSnapshot: () =>
				snapshot({
					telegram: { ...snapshot().telegram, botToken: secrets[0] },
					discord: { botToken: secrets[1] },
				}),
		} as unknown as Settings;
		const context = {
			settings,
			session: { notificationSessionController: undefined },
			sessionManager: { getCwd: () => "/unused", getSessionId: () => "session" },
		} as unknown as NotificationsEditorAdapterContext;
		const ownerId = `owner-${sensitive.join("-")}`;
		const operations = createNotificationsEditorOperations(context, {
			checkNotificationHealth: async () => ({
				...health(),
				daemon: { ...health().daemon, present: true, ownerId },
			}),
			recoverNotifications: async () => ({
				...recovery(),
				endpointsScanned: 1,
				endpointsRemoved: [{ sessionId: sensitive.join("-"), pid: 42, reason: "stale-flag" }],
				endpointsDetached: sensitive.map(value => `/detached/${value}.json`),
				endpointsRetainedSuccessors: sensitive.map(value => `/successor/${value}.json`),
				endpointsRetainedPlaceholders: sensitive.map(value => `/placeholder/${value}.json`),
				endpointsRetainedUnknown: sensitive.map(value => `/unknown/${value}.json`),
				debrisRemoved: sensitive.map(value => `/debris/${value}.json`),
				daemon: {
					...recovery().daemon,
					ownerId,
					detail: `detail ${sensitive.join(" ")}`,
					blockingReason: `blocked ${sensitive.join(" ")}`,
					forceCommand: `gjc notify stop ${sensitive.join(" ")}`,
				},
			}),
		});
		const healthReport = await operations.refreshHealth({ probe: false });
		const recovered = await operations.recover();
		const serialized = JSON.stringify({ healthReport, recovered });
		for (const secret of sensitive) expect(serialized).not.toContain(secret);
		expect(healthReport.daemon.ownerId).toContain("owner-");
		expect(recovered.daemon.ownerId).toContain("owner-");
		expect(recovered.daemon.detail).toContain("detail");
		expect(recovered.daemon.forceCommand).toContain("gjc notify stop");
		expect(recovered.endpointsScanned).toBe(1);
		expect(recovered.endpointsRemoved[0]).toMatchObject({ pid: 42, reason: "stale-flag" });
		for (const paths of [
			recovered.endpointsDetached,
			recovered.endpointsRetainedSuccessors,
			recovered.endpointsRetainedPlaceholders,
			recovered.endpointsRetainedUnknown,
			recovered.debrisRemoved,
		]) {
			expect(paths).toHaveLength(sensitive.length);
			expect(paths?.every(value => value.endsWith(".json"))).toBe(true);
		}
	});

	it("redacts configured secrets carried by real persisted stale endpoint IDs", async () => {
		const temp = TempDir.createSync("@gjc-recovery-redaction-");
		const secrets = [TOKEN, "discord-recovery-secret"];
		const sensitive = [...secrets, ...secrets.map(tokenFingerprint)];
		await Bun.write(
			path.join(temp.path(), "config.yml"),
			Bun.YAML.stringify({
				notifications: { telegram: { botToken: secrets[0] }, discord: { botToken: secrets[1] } },
			}),
		);
		const settings = await Settings.loadForScope({ cwd: temp.path(), agentDir: temp.path() });
		try {
			for (const [index, sessionId] of sensitive.entries()) {
				await Bun.write(
					path.join(temp.path(), ".gjc", "state", "sdk", `endpoint-${index}.json`),
					JSON.stringify({
						sessionId,
						url: "ws://127.0.0.1:1",
						token: "endpoint-token",
						pid: process.pid,
						stale: true,
					}),
				);
			}
			const context = {
				settings,
				session: { notificationSessionController: undefined },
				sessionManager: { getCwd: () => temp.path(), getSessionId: () => "session" },
			} as unknown as NotificationsEditorAdapterContext;
			const recovered = await createNotificationsEditorOperations(context).recover();
			expect(recovered.endpointsScanned).toBe(sensitive.length);
			expect(recovered.endpointsRemoved).toHaveLength(sensitive.length);
			for (const secret of sensitive) expect(JSON.stringify(recovered)).not.toContain(secret);
			for (const endpoint of recovered.endpointsRemoved) expect(endpoint.reason).toBe("stale-flag");
		} finally {
			await settings.close();
			temp.removeSync();
		}
	});

	it("stops the Telegram supervisor before removing its configuration", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-settings-remove-"));
		const currentSnapshot = snapshot();
		const events: string[] = [];
		const settings = {
			canPersistDurableConfig: () => true,
			getAgentDir: () => agentDir,
			getNotificationSettingsSnapshot: () => structuredClone(currentSnapshot),
			commitAtomicBatch: async (patches: Array<{ path: string; op: string; value?: unknown }>) => {
				events.push("commit");
				for (const patch of patches) {
					if (patch.path === "notifications.telegram.botToken" && patch.op === "unset")
						currentSnapshot.telegram.botToken = undefined;
					if (patch.path === "notifications.telegram.chatId" && patch.op === "unset")
						currentSnapshot.telegram.chatId = undefined;
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
			const operations = createNotificationsEditorOperations(
				{
					settings,
					session: { notificationSessionController: controller },
					sessionManager: { getCwd: () => agentDir, getSessionId: () => "session-current" },
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
			expect(events).toEqual(["blocked", "stop", "commit", "cleared"]);
			expect(currentSnapshot.telegram.enabled).toBe(false);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("notification settings selector lifecycle", () => {
	it.each([
		"restored",
		"still_blocked",
	] as const)("shows the %s outcome and the restore observer warning", async outcome => {
		const draft = {
			chatId: "chat",
			tokenMask: "masked",
			richEnabled: true,
			richDraftEnabled: false,
			streamingEnabled: true,
		};
		const base = selectorOperations({
			preflight: async () => ({ status: "ready", identity: { status: "same" }, message: "ready", draft }),
		});
		const component = selector({
			...base,
			commitConfigure: async () => ({
				status: "blocked_identity",
				receipt: receipt(),
				message: "blocked",
				retainCommitted: () => {},
				restore: async () =>
					outcome === "restored"
						? { status: "restored", reconnect: "attached", observerFailed: true }
						: { status: "still_blocked", observerFailed: true },
			}),
		});
		selectNotifications(component);
		await flush();
		component.handleInput("\n");
		component.handleInput("\n");
		component.handleInput("\n");
		component.handleInput("chat");
		component.handleInput("\n");
		component.handleInput(TOKEN);
		component.handleInput("\n");
		await flush();
		component.handleInput("\n");
		await flush();
		expect(component.render(120).join("\n")).toContain("Restore previous configuration");
		component.handleInput("\n");
		await flush();
		const display = component.render(200).join("\n");
		expect(display).toContain(
			outcome === "restored" ? "Previous Telegram configuration restored" : "activation remains blocked",
		);
		expect(display).toContain("settings observer failed after the restore");
		expect(display).not.toContain(TOKEN);
		component.dispose();
	});

	it.each([
		"settings observer failed",
		"Telegram daemon restart failed",
	])("shows preference %s as a warning", async failure => {
		const component = selector(
			selectorOperations({
				commitPreferences: async () => ({
					receipt: receipt(),
					outcome: "degraded",
					message: `Notification preferences saved, but ${failure}.`,
				}),
			}),
		);
		selectNotifications(component);
		await flush();
		activateActionWithDescription(component, "Draft safe scalar preferences, then save them atomically.");
		activateActionWithDescription(component, "Atomically persist this preference draft.");
		await flush();
		const display = component.render(200).join("\n");
		expect(display).toContain("  WARNING");
		expect(display).toContain("Notification preferences saved");
		expect(display).toContain(failure);
		expect(display).not.toContain("  OK");
		component.dispose();
	});

	it.each([
		{ runtimeFenced: true, markerRestoreFailed: false, markerRetainFailed: false },
		{ runtimeFenced: false, markerRestoreFailed: false, markerRetainFailed: false },
		{ runtimeFenced: true, markerRestoreFailed: true, markerRetainFailed: false },
		{ runtimeFenced: false, markerRestoreFailed: false, markerRetainFailed: true },
	])("shows restored failure and fencing status: %o", async failure => {
		const { runtimeFenced, markerRestoreFailed, markerRetainFailed } = failure;
		const draft = {
			chatId: "chat",
			tokenMask: "masked",
			richEnabled: true,
			richDraftEnabled: false,
			streamingEnabled: true,
		};
		const base = selectorOperations({
			preflight: async () => ({ status: "ready", identity: { status: "same" }, message: "ready", draft }),
		});
		const component = selector({
			...base,
			commitConfigure: async () => ({
				status: "blocked_identity",
				receipt: receipt(),
				message: "blocked",
				retainCommitted: () => {},
				restore: async () => ({
					status: "restored",
					runtimeFailed: true,
					runtimeFenced,
					markerRestoreFailed,
					markerRetainFailed,
					observerFailed: true,
				}),
			}),
		});
		selectNotifications(component);
		await flush();
		component.handleInput("\n");
		component.handleInput("\n");
		component.handleInput("\n");
		component.handleInput("chat");
		component.handleInput("\n");
		component.handleInput(TOKEN);
		component.handleInput("\n");
		await flush();
		component.handleInput("\n");
		await flush();
		component.handleInput("\n");
		await flush();
		const display = component.render(300).join("\n");
		expect(display).toContain("  WARNING");
		expect(display).toContain("Previous Telegram configuration restored");
		expect(display).toContain(runtimeFenced ? "current runtime was fenced" : "current runtime could not be fenced");
		expect(display).toContain("settings observer failed after the restore");
		if (markerRestoreFailed) expect(display).toContain("Inactive marker restore failed");
		if (markerRetainFailed) expect(display).toContain("Inactive marker retention failed; its state is unconfirmed");
		component.dispose();
	});

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
