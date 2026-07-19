import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CasReceipt, CasRestoreResult } from "../src/config/atomic-yaml-patch";
import type { SettingsAtomicPatch, SettingsAtomicReceipt } from "../src/config/settings";
import type { NotificationSettingsSnapshot } from "../src/sdk/bus/config";
import { tokenFingerprint } from "../src/sdk/bus/config";
import {
	clearTelegramActivationMarker,
	createTelegramActivationMarker,
	getSaveTelegramInactiveAvailability,
	type NotificationConfigurationWriter,
	persistTelegramActivationMarker,
	proposedTelegramIdentity,
	removeTelegramConfiguration,
	saveTelegramConfiguration,
	saveTelegramInactive,
	type TelegramActivationMarker,
	type TelegramActivationMarkers,
	telegramActivationIdentity,
} from "../src/sdk/bus/notification-orchestration";
import { DAEMON_GENERATION, DAEMON_VERSION, daemonPaths } from "../src/sdk/bus/telegram-daemon";

const TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";
const FOREIGN_TOKEN = "9876543210:ZYXWVutsrqponmlkjihgfedcba987654321";
const agentDirs: string[] = [];

afterEach(() => {
	for (const dir of agentDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notification-orchestration-test-"));
	agentDirs.push(dir);
	return dir;
}

function snapshot(overrides: Partial<NotificationSettingsSnapshot> = {}): NotificationSettingsSnapshot {
	return {
		enabled: true,
		telegram: {
			botToken: "stored-telegram-token",
			chatId: "stored-chat",
			rich: { enabled: true },
			richDraft: { enabled: false },
			toolActivity: { enabled: true },
			topics: {},
			activation: {},
		} as NotificationSettingsSnapshot["telegram"] & { activation: TelegramActivationMarkers },
		discord: {},
		slack: {},
		redact: false,
		verbosity: "lean",
		sessionScope: "all",
		idleTimeoutMs: 60_000,
		...overrides,
	};
}

function receipt(
	input: { onRetain?: () => void; restore?: () => Promise<CasRestoreResult> } = {},
): SettingsAtomicReceipt {
	const restoredReceipt: CasReceipt = {
		revisions: [],
		restore: async () => ({ status: "discarded" }),
		discard: () => {},
	};
	return {
		revisions: [],
		restore: input.restore ?? (async () => ({ status: "restored", receipt: restoredReceipt })),
		discard: () => input.onRetain?.(),
	};
}

function writer(input: { snapshot?: NotificationSettingsSnapshot; agentDir?: string; onCommit?: () => void } = {}): {
	writer: NotificationConfigurationWriter;
	commits: SettingsAtomicPatch[][];
} {
	const initial = input.snapshot ?? snapshot();
	const commits: SettingsAtomicPatch[][] = [];
	return {
		writer: {
			getAgentDir: () => input.agentDir ?? "/tmp/gjc-notification-orchestration",
			getNotificationSettingsSnapshot: () => structuredClone(initial),
			commitAtomicBatch: async patches => {
				input.onCommit?.();
				commits.push(structuredClone(patches) as SettingsAtomicPatch[]);
				return receipt();
			},
			commitAtomicBatchWithCurrent: async buildPatches => {
				const patches = await buildPatches({
					notifications: { telegram: { activation: initial.telegram.activation } },
				});
				input.onCommit?.();
				commits.push(structuredClone(patches) as SettingsAtomicPatch[]);
				return receipt();
			},
		},
		commits,
	};
}

function writeLiveForeignOwner(agentDir: string): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(
		paths.state,
		JSON.stringify({
			pid: 44_444,
			ownerId: "foreign-owner",
			tokenFingerprint: tokenFingerprint(FOREIGN_TOKEN),
			chatId: "foreign-chat",
			startedAt: 1,
			heartbeatAt: 1,
			roots: [],
			version: DAEMON_VERSION,
			generation: DAEMON_GENERATION,
		}),
	);
}

describe("notification orchestration ownership", () => {
	test("foreign preflight cancels before commit without serializing either token", async () => {
		const agentDir = tempAgentDir();
		writeLiveForeignOwner(agentDir);
		const { writer: settings, commits } = writer({ agentDir });

		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: next => proposedTelegramIdentity({ settings, ...next, deps: { pidAlive: pid => pid === 44_444 } }),
		});

		expect(result.status).toBe("cancelled");
		expect(commits).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(JSON.stringify(result)).not.toContain(FOREIGN_TOKEN);
	});

	test("Save inactive preserves Discord while recording only a non-secret Telegram marker", async () => {
		const configured = snapshot({
			discord: {
				botToken: "discord-token",
				applicationId: "discord-app",
				guildId: "discord-guild",
				parentChannelId: "discord-parent",
			},
		});
		const { writer: settings, commits } = writer({ snapshot: configured });
		const markerIdentity = telegramActivationIdentity(TOKEN, "new-chat");

		expect(getSaveTelegramInactiveAvailability(settings)).toEqual({ available: true });
		expect(await saveTelegramInactive({ settings, botToken: TOKEN, chatId: "new-chat" })).toMatchObject({
			status: "saved_inactive",
		});
		expect(commits).toEqual([
			[
				{ path: "notifications.telegram.botToken", op: "set", value: TOKEN },
				{ path: "notifications.telegram.chatId", op: "set", value: "new-chat" },
				{
					path: "notifications.telegram.activation",
					op: "set",
					value: {
						[markerIdentity]: {
							identity: markerIdentity,
							state: "inactive",
							reason: "saved_inactive",
							updatedAt: expect.any(String),
						},
					},
				},
			],
		]);
		expect(JSON.stringify(commits)).not.toContain("discord-token");
	});

	test("removal stops and unregisters the old Telegram runtime before deleting credentials", async () => {
		const events: string[] = [];
		const { writer: settings, commits } = writer({ onCommit: () => events.push("commit") });

		const result = await removeTelegramConfiguration({
			settings,
			removal: {
				stopAndUnregister: async () => {
					events.push("stop-and-unregister");
				},
			},
		});

		expect(result.globallyDisabled).toBe(true);
		expect(events).toEqual(["stop-and-unregister", "commit"]);
		expect(commits).toEqual([
			[
				{ path: "notifications.telegram.botToken", op: "unset" },
				{ path: "notifications.telegram.chatId", op: "unset" },
				{ path: "notifications.telegram.activation", op: "unset" },
				{ path: "notifications.enabled", op: "set", value: false },
			],
		]);
	});

	test("failed runtime teardown leaves credentials untouched", async () => {
		const { writer: settings, commits } = writer();

		await expect(
			removeTelegramConfiguration({
				settings,
				removal: {
					stopAndUnregister: async () => {
						throw new Error("daemon control unavailable");
					},
				},
			}),
		).rejects.toThrow("daemon control unavailable");
		expect(commits).toEqual([]);
	});
});

describe("notification orchestration blocked activation", () => {
	test("blocked identity keeps its marker until configuration rollback is complete", async () => {
		const events: string[] = [];
		const commits: SettingsAtomicPatch[][] = [];
		let endpointRunning = true;
		const activeReceipt = receipt({
			onRetain: () => events.push("retain-active"),
			restore: async () => {
				events.push("restore-active");
				return {
					status: "restored",
					receipt: { revisions: [], restore: async () => ({ status: "discarded" }), discard: () => {} },
				};
			},
		});
		const inactiveReceipt = receipt({
			onRetain: () => events.push("retain-inactive"),
			restore: async () => {
				events.push("restore-inactive");
				return {
					status: "restored",
					receipt: { revisions: [], restore: async () => ({ status: "discarded" }), discard: () => {} },
				};
			},
		});
		const settings: NotificationConfigurationWriter = {
			getAgentDir: () => "/tmp/gjc-notification-orchestration",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async patches => {
				events.push("commit-active");
				commits.push(structuredClone(patches) as SettingsAtomicPatch[]);
				return activeReceipt;
			},
			commitAtomicBatchWithCurrent: async buildPatches => {
				events.push("commit-active");
				commits.push(
					structuredClone(
						await buildPatches({ notifications: { telegram: { activation: {} } } }),
					) as SettingsAtomicPatch[],
				);
				return activeReceipt;
			},
		};
		const marker = createTelegramActivationMarker({
			botToken: TOKEN,
			chatId: "new-chat",
			state: "blocked",
			reason: "identity_mismatch",
			now: new Date("2026-07-13T00:00:00.000Z"),
		});

		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: async () => ({ status: "absent" }),
			activation: {
				marker,
				controller: {
					enterBlockedRuntime: async () => {
						events.push("stop-current-endpoint");
						endpointRunning = false;
					},
					clearBlockedRuntime: async () => events.push("clear-blocked"),
					reconcileCurrentSession: async () => events.push("reconcile"),
				},
				reconnect: async () => {
					events.push("identity-reconnect");
					return events.includes("restore-active") ? "attached" : "blocked_identity";
				},
				persistInactive: async received => {
					events.push(`persist-${received.state}`);
					expect(received).toEqual(marker);
					return inactiveReceipt;
				},
				clearInactive: async () => {
					events.push("clear-inactive");
				},
			},
		});

		expect(result.status).toBe("blocked_identity");
		expect(endpointRunning).toBe(false);
		expect(events).toEqual(["commit-active", "identity-reconnect", "stop-current-endpoint", "persist-blocked"]);
		expect(commits).toEqual([
			[
				{ path: "notifications.telegram.botToken", op: "set", value: TOKEN },
				{ path: "notifications.telegram.chatId", op: "set", value: "new-chat" },
				{ path: "notifications.enabled", op: "set", value: true },
			],
		]);
		if (result.status !== "blocked_identity") throw new Error("Expected blocked identity result.");
		expect(await result.restore()).toEqual({ status: "restored", reconnect: "attached" });
		expect(events).toEqual([
			"commit-active",
			"identity-reconnect",
			"stop-current-endpoint",
			"persist-blocked",
			"restore-active",
			"restore-inactive",
			"identity-reconnect",
			"clear-blocked",
			"reconcile",
		]);
		result.retainCommitted();
		expect(events.slice(-2)).toEqual(["retain-inactive", "retain-active"]);
	});
	test("successful activation clears the previously observed marker without targeting a newer marker", async () => {
		const identity = telegramActivationIdentity(TOKEN, "new-chat");
		const oldMarker = createTelegramActivationMarker({
			botToken: TOKEN,
			chatId: "new-chat",
			state: "inactive",
			reason: "saved_inactive",
			now: new Date("2026-07-12T00:00:00.000Z"),
		});
		const candidateMarker = createTelegramActivationMarker({
			botToken: TOKEN,
			chatId: "new-chat",
			state: "blocked",
			reason: "identity_mismatch",
			now: new Date("2026-07-13T00:00:00.000Z"),
		});
		const { writer: settings } = writer({
			snapshot: snapshot({
				telegram: {
					...snapshot().telegram,
					activation: { [identity]: oldMarker },
				},
			}),
		});
		const cleared: TelegramActivationMarker[] = [];

		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: async () => ({ status: "absent" }),
			activation: {
				marker: candidateMarker,
				controller: {
					enterBlockedRuntime: async () => {},
					clearBlockedRuntime: async () => {},
					reconcileCurrentSession: async () => {},
				},
				reconnect: async () => "attached",
				persistInactive: async () => receipt(),
				clearInactive: async marker => {
					cleared.push(marker);
				},
			},
		});

		expect(result.status).toBe("activated");
		expect(cleared).toEqual([oldMarker]);
	});

	test("concurrent marker writes and clears merge against the durable marker map", async () => {
		let markers: TelegramActivationMarkers = {};
		let queued = Promise.resolve();
		const settings: NotificationConfigurationWriter = {
			getAgentDir: () => "/tmp/gjc-notification-orchestration",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => receipt(),
			commitAtomicBatchWithCurrent: async buildPatches => {
				const prior = queued;
				let release: () => void = () => {};
				queued = new Promise<void>(resolve => {
					release = resolve;
				});
				await prior;
				try {
					const patches = await buildPatches({ notifications: { telegram: { activation: markers } } });
					for (const patch of patches) {
						if (patch.path === "notifications.telegram.activation") {
							markers = patch.op === "unset" ? {} : (structuredClone(patch.value) as TelegramActivationMarkers);
						}
					}
					return receipt();
				} finally {
					release();
				}
			},
		};
		const first = createTelegramActivationMarker({ botToken: TOKEN, chatId: "first", state: "blocked" });
		const second = createTelegramActivationMarker({ botToken: FOREIGN_TOKEN, chatId: "second", state: "inactive" });
		await Promise.all([
			persistTelegramActivationMarker(settings, first),
			persistTelegramActivationMarker(settings, second),
		]);
		expect(markers).toMatchObject({ [first.identity]: first, [second.identity]: second });
		await Promise.all([
			clearTelegramActivationMarker(settings, first),
			persistTelegramActivationMarker(settings, first),
		]);
		expect(markers).toMatchObject({ [first.identity]: first, [second.identity]: second });
	});

	test("a conflicted configuration rollback re-establishes the blocked marker", async () => {
		const events: string[] = [];
		const activeReceipt = receipt({
			restore: async () => ({ status: "conflict", paths: ["notifications.telegram.botToken"] }),
		});
		const inactiveReceipt = receipt({
			restore: async () => ({
				status: "restored",
				receipt: { revisions: [], restore: async () => ({ status: "discarded" }), discard: () => {} },
			}),
		});
		const settings: NotificationConfigurationWriter = {
			getAgentDir: () => "/tmp/gjc-notification-orchestration",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => activeReceipt,
			commitAtomicBatchWithCurrent: async buildPatches => {
				await buildPatches({ notifications: { telegram: { activation: {} } } });
				return activeReceipt;
			},
		};
		const marker = createTelegramActivationMarker({ botToken: TOKEN, chatId: "new-chat", state: "blocked" });
		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: async () => ({ status: "absent" }),
			activation: {
				marker,
				controller: {
					enterBlockedRuntime: async () => {},
					clearBlockedRuntime: async () => {},
					reconcileCurrentSession: async () => {},
				},
				reconnect: async () => "blocked_identity",
				persistInactive: async () => {
					events.push("persist-blocked");
					return inactiveReceipt;
				},
				clearInactive: async () => {},
			},
		});
		if (result.status !== "blocked_identity") throw new Error("Expected blocked identity result.");
		expect(await result.restore()).toEqual({ status: "conflict", paths: ["notifications.telegram.botToken"] });
		expect(events).toEqual(["persist-blocked", "persist-blocked"]);
	});

	test("a marker-restore conflict reports restored configuration as still blocked", async () => {
		const events: string[] = [];
		const activeReceipt = receipt({
			restore: async () => ({
				status: "restored",
				receipt: { revisions: [], restore: async () => ({ status: "discarded" }), discard: () => {} },
			}),
		});
		const inactiveReceipt = receipt({
			restore: async () => ({ status: "conflict", paths: ["notifications.telegram.activation"] }),
		});
		const settings: NotificationConfigurationWriter = {
			getAgentDir: () => "/tmp/gjc-notification-orchestration",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => activeReceipt,
			commitAtomicBatchWithCurrent: async buildPatches => {
				await buildPatches({ notifications: { telegram: { activation: {} } } });
				return activeReceipt;
			},
		};
		const marker = createTelegramActivationMarker({ botToken: TOKEN, chatId: "new-chat", state: "blocked" });
		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: async () => ({ status: "absent" }),
			activation: {
				marker,
				controller: {
					enterBlockedRuntime: async () => events.push("blocked"),
					clearBlockedRuntime: async () => {},
					reconcileCurrentSession: async () => {},
				},
				reconnect: async () => "blocked_identity",
				persistInactive: async () => {
					events.push("persist-blocked");
					return inactiveReceipt;
				},
				clearInactive: async () => {},
			},
		});
		if (result.status !== "blocked_identity") throw new Error("Expected blocked identity result.");
		expect(await result.restore()).toEqual({ status: "still_blocked" });
		expect(events).toEqual(["blocked", "persist-blocked", "persist-blocked", "blocked"]);
	});
});
