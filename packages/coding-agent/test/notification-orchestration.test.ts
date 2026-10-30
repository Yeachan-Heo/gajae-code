import { afterEach, describe, expect, test, vi } from "bun:test";
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
	mutateNotificationProvider,
	type NotificationConfigurationWriter,
	persistTelegramActivationMarker,
	proposedTelegramIdentity,
	removeNotificationProvider,
	removeTelegramConfiguration,
	saveTelegramConfiguration,
	saveTelegramInactive,
	setGlobalNotificationsEnabled,
	type TelegramActivationMarker,
	type TelegramActivationMarkers,
	telegramActivationIdentity,
} from "../src/sdk/bus/notification-orchestration";
import { DAEMON_GENERATION, DAEMON_VERSION, daemonPaths, type TelegramDaemonFs } from "../src/sdk/bus/telegram-daemon";

const TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";
const FOREIGN_TOKEN = "9876543210:ZYXWVutsrqponmlkjihgfedcba987654321";
const agentDirs: string[] = [];

function sessionResult(outcome: "already" | "disabled" | "stopped" | "failed" = "already") {
	return {
		outcome,
		status: {
			eligible: true,
			locallyEnabled: true,
			genericSessionEnabled: true,
			genericEligibilitySource: "configured_provider" as const,
			running: false,
		},
	};
}

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
			sound: "important",
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

function writeLiveForeignOwner(agentDir: string, incarnation = "linux:44444"): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(
		paths.state,
		JSON.stringify({
			pid: 44_444,
			incarnation,
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
	test.each(["foreign", "unknown"] as const)("%s identity cancels by default without writes", async status => {
		const { writer: settings, commits } = writer();
		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: async () => ({ status }),
		});
		expect(result).toMatchObject({ status: "cancelled", preflight: { status } });
		expect(commits).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});
	test("foreign preflight cancels before commit without serializing either token", async () => {
		const agentDir = tempAgentDir();
		writeLiveForeignOwner(agentDir);
		const { writer: settings, commits } = writer({ agentDir });

		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: next =>
				proposedTelegramIdentity({
					settings,
					...next,
					deps: { pidAlive: pid => pid === 44_444, pidIncarnation: () => "linux:44444" },
				}),
		});

		expect(result.status).toBe("cancelled");
		expect(commits).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(JSON.stringify(result)).not.toContain(FOREIGN_TOKEN);
	});

	test("recycled live PID is absent during post-setup identity validation", async () => {
		const agentDir = tempAgentDir();
		writeLiveForeignOwner(agentDir, "linux:12345");
		const { writer: settings } = writer({ agentDir });

		await expect(
			proposedTelegramIdentity({
				settings,
				botToken: TOKEN,
				chatId: "new-chat",
				deps: { pidAlive: () => true, pidIncarnation: () => "linux:67890" },
			}),
		).resolves.toEqual({ status: "absent" });
	});

	test.each([
		{ name: "dead", persisted: "linux:44444", observed: "linux:44444", alive: false, expected: "absent" },
		{ name: "same", persisted: "linux:44444", observed: "linux:44444", alive: true, expected: "same" },
		{ name: "foreign", persisted: "linux:44444", observed: "linux:44444", alive: true, expected: "foreign" },
		{ name: "recycled", persisted: "linux:44444", observed: "linux:55555", alive: true, expected: "absent" },
		{ name: "missing persisted", persisted: undefined, observed: "linux:44444", alive: true, expected: "unknown" },
		{
			name: "invalid persisted",
			persisted: "linux:invalid",
			observed: "linux:44444",
			alive: true,
			expected: "unknown",
		},
		{ name: "missing observed", persisted: "linux:44444", observed: undefined, alive: true, expected: "unknown" },
		{
			name: "invalid observed",
			persisted: "linux:44444",
			observed: "linux:invalid",
			alive: true,
			expected: "unknown",
		},
		{ name: "throwing observed", persisted: "linux:44444", observed: "throw", alive: true, expected: "unknown" },
		{
			name: "throwing liveness",
			persisted: "linux:44444",
			observed: "linux:44444",
			alive: "throw",
			expected: "unknown",
		},
	] as const)("classifies $name process evidence without exposing secrets", async scenario => {
		const agentDir = tempAgentDir();
		writeLiveForeignOwner(agentDir);
		const statePath = daemonPaths(agentDir).state;
		const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
		state.incarnation = scenario.persisted;
		if (scenario.name === "same") {
			state.tokenFingerprint = tokenFingerprint(TOKEN);
			state.chatId = "new-chat";
		}
		fs.writeFileSync(statePath, JSON.stringify(state));
		const { writer: settings } = writer({ agentDir });
		const result = await proposedTelegramIdentity({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			chatDisplay: "approved-chat",
			deps: {
				pidAlive: () => {
					if (scenario.alive === "throw") throw new Error(TOKEN);
					return scenario.alive;
				},
				pidIncarnation: () => {
					if (scenario.observed === "throw") throw new Error(tokenFingerprint(FOREIGN_TOKEN));
					return scenario.observed;
				},
			},
		});
		expect(result.status).toBe(scenario.expected);
		if (scenario.expected === "same") expect(result.owner).toMatchObject({ chatDisplay: "approved-chat" });
		if (scenario.expected === "foreign") expect(result.owner).not.toHaveProperty("chatDisplay");
		if (scenario.expected === "unknown" && scenario.alive !== "throw" && scenario.observed !== "throw") {
			expect(result.owner).toEqual({ ownerId: "foreign-owner", pid: 44_444, generation: DAEMON_GENERATION });
		}
		for (const secret of [TOKEN, FOREIGN_TOKEN, tokenFingerprint(TOKEN), tokenFingerprint(FOREIGN_TOKEN)]) {
			expect(JSON.stringify(result)).not.toContain(secret);
		}
	});

	test.each([
		"null",
		"false",
		"0",
		'""',
		"[]",
		"{",
		"{}",
	])("malformed persisted state %s is unknown, not absent", async raw => {
		const agentDir = tempAgentDir();
		const paths = daemonPaths(agentDir);
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(paths.state, raw);
		const { writer: settings } = writer({ agentDir });
		expect(await proposedTelegramIdentity({ settings, botToken: TOKEN, chatId: "new-chat" })).toEqual({
			status: "unknown",
		});
	});

	test("never returns secrets embedded in untrusted owner metadata or display", async () => {
		const agentDir = tempAgentDir();
		writeLiveForeignOwner(agentDir);
		const statePath = daemonPaths(agentDir).state;
		const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
		state.ownerId = `owner-${tokenFingerprint(FOREIGN_TOKEN)}`;
		fs.writeFileSync(statePath, JSON.stringify(state));
		const { writer: settings } = writer({ agentDir });
		const deps = { pidAlive: () => true, pidIncarnation: () => "linux:44444" };
		expect(await proposedTelegramIdentity({ settings, botToken: TOKEN, chatId: "new-chat", deps })).toEqual({
			status: "unknown",
		});
		state.ownerId = "owner";
		state.tokenFingerprint = tokenFingerprint(TOKEN);
		state.chatId = "new-chat";
		fs.writeFileSync(statePath, JSON.stringify(state));
		const result = await proposedTelegramIdentity({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			chatDisplay: TOKEN,
			deps,
		});
		expect(result).toMatchObject({ status: "same", owner: { ownerId: "owner" } });
		expect(result.owner).not.toHaveProperty("chatDisplay");
	});

	test("rejects stored provider secrets, their fingerprints, and foreign chat IDs in owner metadata", async () => {
		const agentDir = tempAgentDir();
		writeLiveForeignOwner(agentDir);
		const statePath = daemonPaths(agentDir).state;
		const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
		const stored = ["old-telegram-secret", "discord-secret", "slack-bot-secret", "slack-app-secret"];
		const { writer: settings } = writer({
			agentDir,
			snapshot: snapshot({
				telegram: { ...snapshot().telegram, botToken: stored[0] },
				discord: { botToken: stored[1] },
				slack: { botToken: stored[2], appToken: stored[3] },
			}),
		});
		for (const sensitive of [...stored, ...stored.map(tokenFingerprint), state.chatId]) {
			state.ownerId = `owner-${sensitive}`;
			fs.writeFileSync(statePath, JSON.stringify(state));
			const result = await proposedTelegramIdentity({
				settings,
				botToken: TOKEN,
				chatId: "new-chat",
				deps: {
					pidAlive: () => true,
					pidIncarnation: () => "linux:44444",
				},
			});
			expect(result).toEqual({ status: "unknown" });
			expect(JSON.stringify(result)).not.toContain(sensitive);
		}
	});

	test("a missing state file is absent", async () => {
		const { writer: settings } = writer({ agentDir: tempAgentDir() });
		expect(await proposedTelegramIdentity({ settings, botToken: TOKEN, chatId: "new-chat" })).toEqual({
			status: "absent",
		});
	});

	test("an unreadable state file is unknown without exposing its error", async () => {
		const { writer: settings } = writer({ agentDir: tempAgentDir() });
		const fsImpl = {
			...fs.promises,
			readFile: async () => {
				throw Object.assign(new Error(TOKEN), { code: "EACCES" });
			},
		} as unknown as TelegramDaemonFs;
		const result = await proposedTelegramIdentity({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			deps: { fs: fsImpl },
		});
		expect(result).toEqual({ status: "unknown" });
	});

	test.each([
		{ code: "ESRCH", expected: "absent" },
		{ code: "EPERM", expected: "foreign" },
		{ code: "EIO", expected: "unknown" },
	] as const)("default liveness classifies $code correctly", async ({ code, expected }) => {
		const agentDir = tempAgentDir();
		writeLiveForeignOwner(agentDir);
		const { writer: settings } = writer({ agentDir });
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error(TOKEN), { code });
		});
		try {
			const result = await proposedTelegramIdentity({
				settings,
				botToken: TOKEN,
				chatId: "new-chat",
				deps: { pidIncarnation: () => "linux:44444" },
			});
			expect(result.status).toBe(expected);
			expect(kill).toHaveBeenCalledWith(44_444, 0);
			expect(JSON.stringify(result)).not.toContain(TOKEN);
			expect(JSON.stringify(result)).not.toContain(tokenFingerprint(FOREIGN_TOKEN));
		} finally {
			kill.mockRestore();
		}
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
				{ path: "notifications.telegram.enabled", op: "set", value: false },
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

		expect(result.globallyDisabled).toBe(false);
		expect(events).toEqual(["stop-and-unregister", "commit"]);
		expect(commits).toEqual([
			[
				{ path: "notifications.telegram.botToken", op: "unset" },
				{ path: "notifications.telegram.chatId", op: "unset" },
				{ path: "notifications.telegram.activation", op: "unset" },
				{ path: "notifications.telegram.enabled", op: "set", value: false },
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
	test.each([
		"blocked_identity",
		"disabled",
	] as const)("reports failed fencing after %s activation", async reconnect => {
		const settings = writer().writer;
		let markerWrites = 0;
		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "chat",
			saveInactive: false,
			preflight: async () => ({ status: "same" }),
			activation: {
				marker: createTelegramActivationMarker({ botToken: TOKEN, chatId: "chat", state: "blocked" }),
				persistInactive: async () => {
					markerWrites++;
					return receipt();
				},
				clearInactive: async () => {},
				reconnect: async () => reconnect,
				controller: {
					enterBlockedRuntime: async () => false,
					clearBlockedRuntime: async () => {},
					reconcileCurrentSession: async () => sessionResult(),
				},
			},
		});
		expect(result.status).toBe("activation_failed");
		if (result.status !== "activation_failed") throw new Error("Expected activation failure.");
		expect(result.message).toContain("could not be fenced");
		expect(result.receipt).toBeDefined();
		expect(markerWrites).toBe(0);
	});

	test("reports failed fencing when restored identity remains blocked", async () => {
		const settings = writer().writer;
		let fences = 0;
		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "chat",
			saveInactive: false,
			preflight: async () => ({ status: "same" }),
			activation: {
				marker: createTelegramActivationMarker({ botToken: TOKEN, chatId: "chat", state: "blocked" }),
				persistInactive: async () => receipt(),
				clearInactive: async () => {},
				reconnect: async () => "blocked_identity",
				controller: {
					enterBlockedRuntime: async () => ++fences === 1,
					clearBlockedRuntime: async () => {
						throw new Error("unexpected clear");
					},
					reconcileCurrentSession: async () => sessionResult(),
				},
			},
		});
		if (result.status !== "blocked_identity") throw new Error("Expected blocked activation.");
		expect(await result.restore()).toMatchObject({
			status: "restored",
			reconnect: "blocked_identity",
			runtimeFailed: true,
			runtimeFenced: false,
		});
		expect(fences).toBe(2);
	});
	test.each([
		"failed",
		"disabled",
		"stopped",
	] as const)("handles post-commit reconciliation outcome %s", async outcome => {
		for (const fenceResult of ["success", "throw", "false"] as const) {
			const committed = receipt();
			const settings = writer().writer;
			settings.commitAtomicBatchWithCurrent = async () => committed;
			let fences = 0;
			const result = await saveTelegramConfiguration({
				settings,
				botToken: TOKEN,
				chatId: "chat",
				saveInactive: false,
				preflight: async () => ({ status: "same" }),
				activation: {
					marker: createTelegramActivationMarker({ botToken: TOKEN, chatId: "chat", state: "blocked" }),
					persistInactive: async () => receipt(),
					clearInactive: async () => {},
					reconnect: async () => "attached",
					controller: {
						enterBlockedRuntime: async () => {
							fences++;
							if (fenceResult === "throw") throw new Error(TOKEN);
							return fenceResult !== "false";
						},
						clearBlockedRuntime: async () => {},
						reconcileCurrentSession: async () => sessionResult(outcome),
					},
				},
			});
			if (!("receipt" in result)) throw new Error("Expected durable receipt.");
			expect(result.receipt).toBe(committed);
			if (outcome === "failed") {
				expect(result.status).toBe("activation_failed");
				if (result.status !== "activation_failed") throw new Error("Expected activation failure.");
				expect(result.message).toContain(fenceResult !== "success" ? "could not be fenced" : "was fenced");
				expect(fences).toBe(1);
				expect(JSON.stringify(result)).not.toContain(TOKEN);
			} else {
				expect(result.status).toBe("activated");
				expect(fences).toBe(0);
			}
		}
	});
	test.each([
		"reconnect",
		"clear",
		"reconcile",
		"reconcile-outcome",
	] as const)("reports durable restore when post-restore %s fails and fences the runtime", async failingStep => {
		for (const fenceResult of ["success", "throw", "false"] as const) {
			let configuration = "new";
			let markerPresent = false;
			let blocked = false;
			let reconnects = 0;
			let fences = 0;
			const activeReceipt = receipt({
				restore: async () => {
					configuration = "previous";
					return { status: "restored", receipt: receipt() };
				},
			});
			const inactiveReceipt = receipt({
				restore: async () => {
					markerPresent = false;
					return { status: "restored", receipt: receipt() };
				},
			});
			const settings: NotificationConfigurationWriter = {
				getAgentDir: () => "/unused",
				getNotificationSettingsSnapshot: () => snapshot(),
				commitAtomicBatch: async () => activeReceipt,
				commitAtomicBatchWithCurrent: async build => {
					await build({ notifications: { telegram: {} } });
					return activeReceipt;
				},
			};
			const marker = createTelegramActivationMarker({ botToken: TOKEN, chatId: "new-chat", state: "blocked" });
			const result = await saveTelegramConfiguration({
				settings,
				botToken: TOKEN,
				chatId: "new-chat",
				saveInactive: false,
				preflight: async () => ({ status: "same" }),
				activation: {
					marker,
					persistInactive: async () => {
						markerPresent = true;
						return inactiveReceipt;
					},
					clearInactive: async () => {},
					reconnect: async () => {
						if (++reconnects === 1) return "blocked_identity";
						if (failingStep === "reconnect") throw new Error(TOKEN);
						return "attached";
					},
					controller: {
						enterBlockedRuntime: async () => {
							if (++fences === 2 && fenceResult === "throw") throw new Error(TOKEN);
							if (fences === 2 && fenceResult === "false") return false;
							blocked = true;
							return true;
						},
						clearBlockedRuntime: async () => {
							blocked = false;
							if (failingStep === "clear") throw new Error(TOKEN);
						},
						reconcileCurrentSession: async () => {
							if (failingStep === "reconcile") throw new Error(TOKEN);
							return sessionResult(failingStep === "reconcile-outcome" ? "failed" : "already");
						},
					},
				},
			});
			if (result.status !== "blocked_identity") throw new Error("Expected blocked activation.");
			expect(markerPresent).toBe(true);
			const restored = await result.restore();
			expect(restored).toMatchObject({
				status: "restored",
				runtimeFailed: true,
				runtimeFenced: fenceResult === "success",
			});
			expect(JSON.stringify(restored)).not.toContain(TOKEN);
			expect(configuration).toBe("previous");
			expect(markerPresent).toBe(false);
			expect(fences).toBe(2);
			if (fenceResult === "success") expect(blocked).toBe(true);
		}
	});

	test.each([
		"primary",
		"marker",
	] as const)("handles a not-restorable %s receipt without reconnecting", async target => {
		const events: string[] = [];
		const active = receipt({
			restore: async () => {
				events.push("restore-primary");
				return target === "primary" ? { status: "not-restorable" } : { status: "restored", receipt: receipt() };
			},
		});
		const inactive = receipt({
			restore: async () => {
				events.push("restore-marker");
				return { status: "not-restorable" };
			},
		});
		const settings = writer().writer;
		settings.commitAtomicBatchWithCurrent = async () => active;
		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "chat",
			saveInactive: false,
			preflight: async () => ({ status: "same" }),
			activation: {
				marker: createTelegramActivationMarker({ botToken: TOKEN, chatId: "chat", state: "blocked" }),
				persistInactive: async () => {
					events.push("persist-marker");
					return inactive;
				},
				clearInactive: async () => {
					events.push("clear-marker");
				},
				reconnect: async () => {
					events.push("reconnect");
					return "blocked_identity";
				},
				controller: {
					enterBlockedRuntime: async () => {
						events.push("fence");
						return true;
					},
					clearBlockedRuntime: async () => {
						events.push("clear-block");
					},
					reconcileCurrentSession: async () => {
						events.push("reconcile");
						return sessionResult();
					},
				},
			},
		});
		if (result.status !== "blocked_identity") throw new Error("Expected blocked activation.");
		const restored = await result.restore();
		if (target === "primary") {
			expect(restored).toEqual({ status: "not-restorable" });
			expect(events).toEqual(["reconnect", "fence", "persist-marker", "restore-primary", "persist-marker"]);
		} else {
			expect(restored).toMatchObject({
				status: "restored",
				runtimeFailed: true,
				runtimeFenced: true,
				markerRestoreFailed: true,
			});
			expect(events).toEqual([
				"reconnect",
				"fence",
				"persist-marker",
				"restore-primary",
				"restore-marker",
				"persist-marker",
				"fence",
			]);
		}
	});

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
						return true;
					},
					clearBlockedRuntime: async () => events.push("clear-blocked"),
					reconcileCurrentSession: async () => {
						events.push("reconcile");
						return sessionResult();
					},
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
				{ path: "notifications.telegram.enabled", op: "set", value: true },
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
					enterBlockedRuntime: async () => true,
					clearBlockedRuntime: async () => {},
					reconcileCurrentSession: async () => sessionResult(),
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
					enterBlockedRuntime: async () => true,
					clearBlockedRuntime: async () => {},
					reconcileCurrentSession: async () => sessionResult(),
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

	test("primary restore failure remains an error without exposing receipt or marker errors", async () => {
		const activeReceipt = receipt({
			restore: async () => {
				throw new Error(TOKEN);
			},
		});
		let writes = 0;
		const settings: NotificationConfigurationWriter = {
			getAgentDir: () => "/unused",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => activeReceipt,
			commitAtomicBatchWithCurrent: async build => {
				await build({ notifications: { telegram: {} } });
				return activeReceipt;
			},
		};
		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: async () => ({ status: "same" }),
			activation: {
				marker: createTelegramActivationMarker({ botToken: TOKEN, chatId: "new-chat", state: "blocked" }),
				persistInactive: async () => {
					if (++writes === 2) throw new Error(tokenFingerprint(TOKEN));
					return receipt();
				},
				clearInactive: async () => {},
				reconnect: async () => "blocked_identity",
				controller: {
					enterBlockedRuntime: async () => true,
					clearBlockedRuntime: async () => {},
					reconcileCurrentSession: async () => sessionResult(),
				},
			},
		});
		if (result.status !== "blocked_identity") throw new Error("Expected blocked activation.");
		await expect(result.restore()).rejects.toThrow("Telegram configuration restore failed.");
		expect(writes).toBe(2);
	});

	test.each([
		"marker restore",
		"marker retain",
		"runtime fence",
		"runtime fence false",
	] as const)("reports durable configuration restoration when %s fails", async failure => {
		let configuration = "new";
		let markerPresent = false;
		let writes = 0;
		let fences = 0;
		let primaryRestores = 0;
		const activeReceipt = receipt({
			restore: async () => {
				if (++primaryRestores !== 1) throw new Error("primary receipt consumed");
				configuration = "previous";
				return { status: "restored", receipt: receipt() };
			},
		});
		const inactiveReceipt = receipt({
			restore: async () => {
				if (failure === "marker restore") throw new Error(TOKEN);
				return { status: "conflict", paths: ["notifications.telegram.activation"] };
			},
		});
		const settings: NotificationConfigurationWriter = {
			getAgentDir: () => "/unused",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async () => activeReceipt,
			commitAtomicBatchWithCurrent: async build => {
				await build({ notifications: { telegram: {} } });
				return activeReceipt;
			},
		};
		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: async () => ({ status: "same" }),
			activation: {
				marker: createTelegramActivationMarker({ botToken: TOKEN, chatId: "new-chat", state: "blocked" }),
				persistInactive: async () => {
					if (++writes === 2 && failure === "marker retain") {
						markerPresent = false;
						throw new Error(tokenFingerprint(TOKEN));
					}
					markerPresent = true;
					return inactiveReceipt;
				},
				clearInactive: async () => {},
				reconnect: async () => "blocked_identity",
				controller: {
					enterBlockedRuntime: async () => {
						if (++fences === 2 && failure === "runtime fence") throw new Error(TOKEN);
						return !(fences === 2 && failure === "runtime fence false");
					},
					clearBlockedRuntime: async () => {},
					reconcileCurrentSession: async () => sessionResult(),
				},
			},
		});
		if (result.status !== "blocked_identity") throw new Error("Expected blocked activation.");
		const restored = await result.restore();
		expect(restored).toEqual({
			status: "restored",
			runtimeFailed: true,
			runtimeFenced: failure !== "runtime fence" && failure !== "runtime fence false",
			markerRestoreFailed: failure === "marker restore",
			markerRetainFailed: failure === "marker retain",
		});
		expect(configuration).toBe("previous");
		expect(primaryRestores).toBe(1);
		expect(markerPresent).toBe(failure !== "marker retain");
		expect(writes).toBe(2);
		expect(fences).toBe(2);
		expect(JSON.stringify(restored)).not.toContain(TOKEN);
		expect(JSON.stringify(restored)).not.toContain(tokenFingerprint(TOKEN));
	});

	test("a marker-restore conflict reports restored configuration as marker blocked", async () => {
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
					enterBlockedRuntime: async () => {
						events.push("blocked");
						return true;
					},
					clearBlockedRuntime: async () => {},
					reconcileCurrentSession: async () => sessionResult(),
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
		expect(await result.restore()).toEqual({ status: "marker_blocked" });
		expect(events).toEqual(["blocked", "persist-blocked", "persist-blocked", "blocked"]);
	});
	test("fences the current runtime when post-commit reconnect throws", async () => {
		let fenced = false;
		const { writer: settings } = writer();
		const committed = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: async () => ({ status: "absent" }),
			activation: {
				controller: {
					enterBlockedRuntime: async () => {
						fenced = true;
						return true;
					},
					clearBlockedRuntime: async () => {},
					reconcileCurrentSession: async () => sessionResult(),
				},
				reconnect: async () => {
					throw new Error("reconnect failed");
				},
				persistInactive: async () => receipt(),
				clearInactive: async () => {},
				marker: createTelegramActivationMarker({
					botToken: TOKEN,
					chatId: "new-chat",
					state: "blocked",
				}),
			},
		});
		expect(fenced).toBe(true);
		expect(committed).toMatchObject({ status: "activation_failed", receipt: expect.anything() });
		expect("message" in committed && committed.message).toContain("runtime was fenced");
	});
	test("retains observer and activation failures beside the durable provider receipt", async () => {
		const { writer: settings, commits } = writer();
		const result = await mutateNotificationProvider({
			settings,
			mutation: {
				provider: "discord",
				botToken: { action: "replace", value: "discord-secret" },
				applicationId: "app",
				guildId: "guild",
				parentChannelId: "parent",
			},
			configureAndActivate: true,
			notifyConfigChanged: async () => {
				throw new Error("observer failed");
			},
			runtime: {
				activate: async () => {
					throw new Error("activation failed");
				},
				deactivate: async () => {},
			},
		});
		expect(result).toMatchObject({ status: "activation_failed", observerFailed: true });
		expect("receipt" in result).toBe(true);
		expect(commits).toEqual([
			[
				{ path: "notifications.discord.botToken", op: "set", value: "discord-secret" },
				{ path: "notifications.discord.applicationId", op: "set", value: "app" },
				{ path: "notifications.discord.guildId", op: "set", value: "guild" },
				{ path: "notifications.discord.parentChannelId", op: "set", value: "parent" },
				{ path: "notifications.enabled", op: "set", value: true },
				{ path: "notifications.discord.enabled", op: "set", value: true },
			],
		]);
	});

	test("returns the removal receipt when chat teardown and observation fail after commit", async () => {
		const { writer: settings, commits } = writer();
		const result = await removeNotificationProvider({
			settings,
			provider: "slack",
			notifyConfigChanged: async () => {
				throw new Error("observer failed");
			},
			runtime: {
				activate: async () => {},
				deactivate: async () => {
					throw new Error("teardown failed");
				},
			},
		});
		expect(result).toMatchObject({ status: "deactivation_failed", observerFailed: true });
		expect("receipt" in result && result.receipt).toBeDefined();
		expect(commits[0]).toEqual([
			{ path: "notifications.slack.botToken", op: "unset" },
			{ path: "notifications.slack.appToken", op: "unset" },
			{ path: "notifications.slack.workspaceId", op: "unset" },
			{ path: "notifications.slack.channelId", op: "unset" },
			{ path: "notifications.slack.authorizedUserId", op: "unset" },
			{ path: "notifications.slack.enabled", op: "set", value: false },
		]);
	});

	test("global enable activates only effective desired providers and reports every degraded side effect", async () => {
		const configured = snapshot({
			enabled: true,
			telegram: { ...snapshot().telegram, enabled: false },
			discord: {
				enabled: true,
				botToken: "discord-token",
				applicationId: "app",
				guildId: "guild",
				parentChannelId: "parent",
			},
			slack: {
				enabled: false,
				botToken: "slack-token",
				appToken: "slack-app-token",
				workspaceId: "workspace",
				channelId: "channel",
			},
		});
		const { writer: settings, commits } = writer({ snapshot: configured });
		const activated: string[] = [];
		const result = await setGlobalNotificationsEnabled({
			settings,
			enabled: true,
			notifyConfigChanged: async () => {
				throw new Error("observer failed");
			},
			runtime: {
				activate: async provider => {
					activated.push(provider);
					throw new Error("activation failed");
				},
				deactivate: async () => {},
			},
		});
		expect(result).toMatchObject({
			status: "global_activation_partial",
			failed: ["discord"],
			observerFailed: true,
		});
		expect(activated).toEqual(["discord"]);
		expect(commits).toEqual([[{ path: "notifications.enabled", op: "set", value: true }]]);
	});

	test.each([
		"inactive",
		"blocked",
	] as const)("global enable leaves %s Telegram activation markers inactive while activating safe siblings", state => {
		const telegram = snapshot().telegram;
		const marker = createTelegramActivationMarker({
			botToken: telegram.botToken!,
			chatId: telegram.chatId!,
			state,
			reason: state === "inactive" ? "saved_inactive" : "identity_mismatch",
		});
		const configured = snapshot({
			enabled: true,
			telegram: { ...telegram, enabled: true, activation: { [marker.identity]: marker } },
			discord: {
				enabled: true,
				botToken: "discord-token",
				applicationId: "app",
				guildId: "guild",
				parentChannelId: "parent",
			},
		});
		const { writer: settings } = writer({ snapshot: configured });
		const activated: string[] = [];
		return setGlobalNotificationsEnabled({
			settings,
			enabled: true,
			runtime: {
				activate: async provider => {
					activated.push(provider);
				},
				deactivate: async () => {},
			},
		}).then(result => {
			expect(result.status).toBe("saved");
			expect(activated).toEqual(["discord"]);
		});
	});
	test("required secret removal disables only the selected provider in one batch", async () => {
		const { writer: settings, commits } = writer();
		const deactivated: string[] = [];
		const result = await mutateNotificationProvider({
			settings,
			mutation: {
				provider: "slack",
				botToken: { action: "remove" },
				appToken: { action: "keep" },
			},
			desiredEnabled: true,
			runtime: {
				activate: async () => {},
				deactivate: async provider => {
					deactivated.push(provider);
				},
			},
		});
		expect(result).toMatchObject({ status: "saved", observerFailed: false });
		expect(deactivated).toEqual(["slack"]);
		expect(commits).toEqual([
			[
				{ path: "notifications.slack.botToken", op: "unset" },
				{ path: "notifications.slack.enabled", op: "set", value: false },
			],
		]);
	});
});
