import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { CasReceipt } from "@gajae-code/coding-agent/config/atomic-yaml-patch";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type {
	NotificationsEditorOperations,
	NotificationsEditorState,
	NotificationsMutationResult,
	NotificationsPreflightResult,
} from "@gajae-code/coding-agent/modes/components/notifications-settings-editor";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import {
	createNotificationsEditorOperations,
	type NotificationsEditorAdapterContext,
	type NotificationsEditorOperationDependencies,
} from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { NotificationSettingsSnapshot } from "@gajae-code/coding-agent/sdk/bus/config";
import {
	createTelegramActivationMarker,
	telegramActivationIdentity,
} from "@gajae-code/coding-agent/sdk/bus/notification-orchestration";
import type {
	NotificationHealthReport,
	NotificationRecoveryReport,
} from "@gajae-code/coding-agent/sdk/bus/notification-service";
import type {
	NotificationSessionReconcileResult,
	NotificationSessionStatus,
} from "@gajae-code/coding-agent/sdk/bus/session-control";

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
			rich: { enabled: true },
			btw: { enabled: true },
			richDraft: { enabled: false },
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

function sessionStatus(): NotificationSessionStatus {
	return {
		eligible: true,
		locallyEnabled: true,
		effectiveEnabled: true,
		running: true,
		environment: "default",
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
			telegram: { botTokenMasked: "(unset)", channel: undefined, configured: false, tokenFingerprint: undefined },
			discord: { botTokenMasked: "(unset)", channel: undefined, configured: false },
			slack: { botTokenMasked: "(unset)", channel: undefined, configured: false },
		},
		session: sessionStatus(),
		preferences: {
			redact: false,
			verbosity: "lean",
			sessionScope: "all",
			richEnabled: true,
			richDraftEnabled: false,
		},
	};
}

function selectorOperations(
	input: {
		preflight?: (signal: AbortSignal) => Promise<NotificationsPreflightResult>;
		enableGlobally?: () => Promise<NotificationsMutationResult>;
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
		enableGlobally: async () => await (input.enableGlobally?.() ?? Promise.resolve({ message: "enabled" })),
		disableGlobally: async () => ({ message: "disabled" }),
		removeTelegram: async () => ({ message: "removed" }),
		setSessionLocal: async () => sessionResult(),
		commitPreferences: async () => ({ message: "saved" }),
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
		const settings = {
			getAgentDir: () => "/tmp/gjc-settings-controller",
			getNotificationSettingsSnapshot: () => structuredClone(currentSnapshot),
			commitAtomicBatch: async (patches: unknown[]) => {
				events.push("commit");
				batches.push(structuredClone(patches));
				return receipt();
			},
		} as unknown as Settings;
		const ctx = {
			settings,
			session: { notificationSessionController: controller },
			sessionManager: { getCwd: () => "/workspace/current", getSessionId: () => "session-current" },
			notifyConfigChanged: async () => events.push("notify"),
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
				expect(input).toEqual({ settings });
				return { ok: true, adapter: "telegram", chatId: "chat", detail: "delivered" };
			},
			recoverNotifications: async input => {
				serviceCalls.push("recover");
				expect(input).toMatchObject({ settings, stateRoot: path.join("/workspace/current", ".gjc", "state") });
				return recovery();
			},
			unregisterNotificationRoot: async () => ({ root: "/workspace/current/.gjc/state", remainingRoots: 1 }),

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
				return { status: "activated", reconnect: "attached" };
			},
		};
		const operations = createNotificationsEditorOperations(ctx, dependencies);

		const loaded = await operations.loadState();
		expect(loaded.session).toEqual(sessionStatus());
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
			{ token: firstSecret as never, chatId: "input-chat", richEnabled: true, richDraftEnabled: false },
			new AbortController().signal,
		);
		expect(firstSecret.consume).toHaveBeenCalledTimes(1);
		expect(firstPreflight).toMatchObject({
			status: "ready",
			draft: { chatId: "validated-chat", tokenMask: expect.not.stringContaining(TOKEN) },
		});
		expect(setupCalls[0]).toMatchObject({ chatId: "input-chat", interactive: false });
		expect(identityCalls[0]).toMatchObject({ chatId: "validated-chat", chatDisplay: "validated-chat" });

		const discoveredPreflight = await operations.preflightProposedIdentity(
			{ token: secret() as never, richEnabled: true, richDraftEnabled: false },
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
			{ path: "notifications.telegram.rich.enabled", op: "set", value: true },
			{ path: "notifications.telegram.richDraft.enabled", op: "set", value: false },
		]);
		expect(events.slice(0, 3)).toEqual(["commit", "reconcile", "notify"]);

		const secondPreflight = await operations.preflightProposedIdentity(
			{ token: secret() as never, chatId: "input-chat", richEnabled: true, richDraftEnabled: false },
			new AbortController().signal,
		);
		if (!secondPreflight.draft) throw new Error("Expected prepared Telegram draft.");
		await operations.saveInactive(secondPreflight.draft);
		const inactiveIdentity = telegramActivationIdentity(TOKEN, "validated-chat");
		expect(batches[1]).toEqual([
			{ path: "notifications.telegram.botToken", op: "set", value: TOKEN },
			{ path: "notifications.telegram.chatId", op: "set", value: "validated-chat" },
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
			{ path: "notifications.enabled", op: "set", value: false },
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
		]);

		await operations.setSessionLocal(false);
		await operations.reconcileCurrentSession();
		expect(controller.setLocalEnabled).toHaveBeenCalledWith(
			expect.objectContaining({ sessionManager: ctx.sessionManager }),
			false,
		);
		expect(controller.reconcileCurrentSession).toHaveBeenCalledWith(
			expect.objectContaining({ sessionManager: ctx.sessionManager }),
		);
		await operations.commitPreferences({
			redact: true,
			verbosity: "verbose",
			sessionScope: "primary",
			richEnabled: false,
			richDraftEnabled: true,
		});
		expect(batches.at(-1)).toEqual([
			{ path: "notifications.redact", op: "set", value: true },
			{ path: "notifications.verbosity", op: "set", value: "verbose" },
			{ path: "notifications.sessionScope", op: "set", value: "primary" },
			{ path: "notifications.telegram.rich.enabled", op: "set", value: false },
			{ path: "notifications.telegram.richDraft.enabled", op: "set", value: true },
		]);

		const discarded = await operations.preflightProposedIdentity(
			{ token: secret() as never, chatId: "input-chat", richEnabled: true, richDraftEnabled: false },
			new AbortController().signal,
		);
		if (!discarded.draft) throw new Error("Expected prepared Telegram draft.");
		operations.discardConfigureDraft(discarded.draft);
		await expect(operations.commitConfigure(discarded.draft)).rejects.toThrow("draft expired");
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
		const settings = {
			getAgentDir: () => "/tmp/gjc-settings-controller",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => {
				events.push("commit");
				return receipt();
			},
		} as unknown as Settings;
		const operations = createNotificationsEditorOperations(
			{
				settings,
				session: { notificationSessionController: controller },
				sessionManager: { getCwd: () => "/workspace/current", getSessionId: () => "session-current" },
				notifyConfigChanged: async () => events.push("notify"),
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
			{ token: secret() as never, chatId: "chat", richEnabled: true, richDraftEnabled: false },
			new AbortController().signal,
		);
		if (!result.draft) throw new Error("Expected prepared Telegram draft.");
		const committed = await operations.commitConfigure(result.draft);
		expect(committed).toMatchObject({ status: "blocked_identity" });
		if (committed.status !== "blocked_identity") throw new Error("Expected blocked identity result.");
		expect(typeof committed.restore).toBe("function");
		expect(typeof committed.retainCommitted).toBe("function");
		expect(events).toEqual(["commit", "ensure", "enter-blocked", "commit", "notify"]);
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
});
