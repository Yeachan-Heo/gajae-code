import { describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { runChatDaemonInternal } from "../src/sdk/bus/chat-daemon-cli";
import {
	acquireChatDaemonOwnership,
	ChatDaemonController,
	chatDaemonGeneration,
	chatDaemonPaths,
	ensureDiscordDaemon,
	ensureSlackDaemon,
	hasSafeChatDaemonStateShape,
	readChatDaemonState,
	releaseChatDaemonOwnership,
} from "../src/sdk/bus/chat-daemon-control";
import { setPrivateAgentDir, tempAgentDir } from "./helpers/daemon-control-fixture";

function testChatProcessReference(signalRoot: (pid: number, value: NodeJS.Signals) => void) {
	return (pid: number) => ({
		incarnation: "linux:12345",
		signalRoot: (value: NodeJS.Signals) => signalRoot(pid, value),
	});
}

describe("ChatDaemonController ownership safety", () => {
	test("does not signal a reused PID incarnation", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 77,
				ownerId: "owner-a",
				identity,
				incarnation: "linux:12344",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		const signals: NodeJS.Signals[] = [];
		const controller = new ChatDaemonController(s, "discord", {
			pidAlive: pid => pid === 77,
			pidIncarnation: () => "linux:12346",
			processReference: testChatProcessReference((_pid, signal) => signals.push(signal)),
		});
		expect((await controller.status()).health).toBe("stopped");
		const result = await controller.stop();
		expect(result.ok).toBe(true);
		expect(signals).toEqual([]);
	});

	test.each([
		["discord", "EPERM", "operation not permitted"],
		["discord", undefined, "probe authority unavailable"],
		["slack", "EPERM", "operation not permitted"],
		["slack", undefined, "probe authority unavailable"],
	] as const)("treats %s %s liveness probes as an existing chat daemon owner", async (kind, code, message) => {
		const agentDir = tempAgentDir();
		const providerSettings =
			kind === "discord"
				? {
						"notifications.discord.botToken": "discord-token",
						"notifications.discord.applicationId": "app",
						"notifications.discord.guildId": "guild",
						"notifications.discord.parentChannelId": "parent",
					}
				: {
						"notifications.slack.botToken": "slack-token",
						"notifications.slack.appToken": "slack-app-token",
						"notifications.slack.workspaceId": "workspace",
						"notifications.slack.channelId": "channel",
					};
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				...providerSettings,
			}) as Settings,
			agentDir,
		);
		const identityParts =
			kind === "discord"
				? ["discord-token", "app", "guild", "parent", "false", "lean"]
				: ["slack-token", "slack-app-token", "workspace", "channel", "", "false", "lean"];
		const identity = crypto.createHash("sha256").update(identityParts.join("\0")).digest("hex").slice(0, 16);
		const paths = chatDaemonPaths(agentDir, kind);
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind,
				pid: 77,
				ownerId: "owner-a",
				identity,
				incarnation: "linux:12345",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration(kind),
			}),
		);
		const kill = spyOn(process, "kill").mockImplementation(() => {
			const error = new Error(message) as NodeJS.ErrnoException;
			if (code) error.code = code;
			throw error;
		});
		let spawns = 0;
		try {
			const controller = new ChatDaemonController(s, kind, {
				pidIncarnation: () => "linux:12345",
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			});
			expect((await controller.status()).health).toBe("running");
			expect(await controller.ensure()).toBe("attached");
			expect(spawns).toBe(0);
		} finally {
			kill.mockRestore();
		}
	});

	test("refuses Darwin default TERM/KILL without opening the native numeric-PID signal path", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 77,
				ownerId: "owner-a",
				identity,
				incarnation: "darwin:77:1",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration("discord"),
			}),
		);

		const result = await new ChatDaemonController(s, "discord", {
			platform: "darwin",
			pidAlive: pid => pid === 77,
			pidIncarnation: () => "darwin:77:1",
		}).stop({ force: true, gracefulTimeoutMs: 1, killTimeoutMs: 1 });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("ownership changed");
	});

	test("signals a stable chat reference when a numeric PID is reused immediately before TERM", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 77,
				ownerId: "owner-a",
				identity,
				incarnation: "linux:12345",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		let currentIncarnation = "linux:12345";
		let oldOwnerAlive = true;
		const stableSignals: NodeJS.Signals[] = [];
		const replacementSignals: NodeJS.Signals[] = [];
		const result = await new ChatDaemonController(s, "discord", {
			pidAlive: pid => pid === 77 && oldOwnerAlive,
			pidIncarnation: () => currentIncarnation,
			processReference: () => {
				currentIncarnation = "linux:12346";
				return {
					incarnation: "linux:12345",
					signalRoot: signal => {
						stableSignals.push(signal);
						oldOwnerAlive = false;
					},
					killTree: () => {
						throw new Error("tree signaling must never be used");
					},
					groupId: () => {
						throw new Error("process-group signaling must never be used");
					},
					children: () => {
						throw new Error("descendant discovery must never be used");
					},
				};
			},
		}).stop();
		expect(result.ok).toBe(true);
		expect(stableSignals).toEqual(["SIGTERM"]);
		expect(replacementSignals).toEqual([]);
	});

	test("releases chat ownership only with live exact PID and incarnation provenance", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		const state = {
			version: 1,
			kind: "discord",
			pid: 77,
			ownerId: "owner-a",
			identity: "identity",
			incarnation: "linux:12345",
			startedAt: 1,
			heartbeatAt: 1,
			transportHealthy: true,
			generation: chatDaemonGeneration("discord"),
		};
		const restore = () => {
			fs.writeFileSync(paths.state, JSON.stringify(state));
			fs.writeFileSync(paths.lock, JSON.stringify({ pid: state.pid, incarnation: state.incarnation, createdAt: 1 }));
		};
		const unchanged = () => {
			const persisted = JSON.parse(fs.readFileSync(paths.state, "utf8"));
			expect(persisted).not.toHaveProperty("stoppedAt");
			expect(persisted.transportHealthy).toBe(true);
			expect(fs.existsSync(paths.lock)).toBe(true);
		};
		const release = (input: Record<string, unknown>) =>
			releaseChatDaemonOwnership({
				agentDir,
				kind: "discord",
				ownerId: "owner-a",
				pid: 77,
				incarnation: "linux:12345",
				...input,
			} as any);

		for (const input of [
			{ ownerId: "wrong-owner" },
			{ pid: undefined },
			{ pid: 78 },
			{ incarnation: undefined },
			{ incarnation: "wrong" },
			{ incarnation: "stale" },
			{ pidIncarnation: () => "linux:12346" },
			{ pidIncarnation: () => undefined },
			{ pidAlive: () => false, pidIncarnation: () => "linux:12345" },
		]) {
			restore();
			await release(input);
			unchanged();
		}

		restore();
		await release({
			pidAlive: (pid: number) => pid === 77,
			pidIncarnation: (pid: number) => (pid === 77 ? "linux:12345" : undefined),
		});
		const released = JSON.parse(fs.readFileSync(paths.state, "utf8"));
		expect(released).toMatchObject({
			ownerId: "owner-a",
			pid: 77,
			incarnation: "linux:12345",
			transportHealthy: false,
		});
		expect(released.stoppedAt).toEqual(expect.any(Number));
		expect(fs.existsSync(paths.lock)).toBe(false);
	});

	test("settles repeated exact ownership releases deterministically within the existing bounded test contract", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		const state = {
			version: 1,
			kind: "discord",
			pid: 77,
			ownerId: "owner-a",
			identity: "identity",
			incarnation: "linux:12345",
			startedAt: 1,
			heartbeatAt: 1,
			transportHealthy: true,
			generation: chatDaemonGeneration("discord"),
		};
		for (let attempt = 0; attempt < 20; attempt++) {
			fs.writeFileSync(paths.state, JSON.stringify(state));
			fs.writeFileSync(
				paths.lock,
				JSON.stringify({ pid: state.pid, incarnation: state.incarnation, createdAt: attempt }),
			);
			await expect(
				releaseChatDaemonOwnership({
					agentDir,
					kind: "discord",
					ownerId: state.ownerId,
					pid: state.pid,
					incarnation: state.incarnation,
					pidAlive: pid => pid === state.pid,
					pidIncarnation: pid => (pid === state.pid ? state.incarnation : undefined),
				}),
			).resolves.toBeUndefined();
			const released = JSON.parse(fs.readFileSync(paths.state, "utf8"));
			expect(released.transportHealthy).toBe(false);
			expect(released.stoppedAt).toEqual(expect.any(Number));
			expect(fs.existsSync(paths.lock)).toBe(false);
		}
	});

	test("reports a live PID with a disconnected provider as stale", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 77,
				ownerId: "owner-a",
				identity,
				incarnation: "linux:12345",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: false,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		expect(
			(
				await new ChatDaemonController(s, "discord", {
					pidAlive: () => true,
					pidIncarnation: () => "linux:12345",
				}).status()
			).health,
		).toBe("stale");
	});

	test("attaches to a matching live owner without restarting it", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 81,
				ownerId: "owner-a",
				identity,
				incarnation: "linux:12345",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		let spawns = 0;
		expect(
			await ensureDiscordDaemon(s, {
				pidAlive: pid => pid === 81,
				pidIncarnation: () => "linux:12345",
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			}),
		).toBe("attached");
		expect(spawns).toBe(0);
	});

	test("waits for a compatible mid-startup owner to become healthy instead of failing", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		// A concurrent ensure just acquired ownership: physically live and compatible,
		// but transportHealthy:false until its transport heartbeats healthy.
		const baseState = {
			version: 1 as const,
			kind: "discord" as const,
			pid: 90,
			ownerId: "owner-a",
			identity,
			incarnation: "linux:12345",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
			transportHealthy: false,
			generation: chatDaemonGeneration("discord"),
		};
		fs.writeFileSync(paths.state, JSON.stringify(baseState));
		let spawns = 0;
		const result = await ensureDiscordDaemon(s, {
			pidAlive: pid => pid === 90,
			pidIncarnation: () => "linux:12345",
			spawnReadyTimeoutMs: 1_000,
			sleep: async () => {
				// The owning process finishes startup and publishes a healthy heartbeat.
				fs.writeFileSync(
					paths.state,
					JSON.stringify({ ...baseState, transportHealthy: true, heartbeatAt: Date.now() }),
				);
			},
			spawn: () => {
				spawns++;
				return { unref() {} };
			},
		});
		expect(result).toBe("attached");
		expect(spawns).toBe(0);
	});

	test("fails a compatible owner that never becomes healthy within the wait", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 91,
				ownerId: "owner-a",
				identity,
				incarnation: "linux:12345",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: false,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		let spawns = 0;
		await expect(
			ensureDiscordDaemon(s, {
				pidAlive: pid => pid === 91,
				pidIncarnation: () => "linux:12345",
				spawnReadyTimeoutMs: 1,
				sleep: async () => undefined,
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			}),
		).rejects.toThrow("unhealthy");
		expect(spawns).toBe(0);
	});

	test("does not replace a live daemon with a different identity", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "new-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const oldIdentity = crypto
			.createHash("sha256")
			.update(["old-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 82,
				ownerId: "owner-a",
				identity: oldIdentity,
				incarnation: "linux:12345",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		const signals: NodeJS.Signals[] = [];
		let spawns = 0;
		await expect(
			ensureDiscordDaemon(s, {
				pidAlive: pid => pid === 82,
				pidIncarnation: () => "linux:12345",
				processReference: testChatProcessReference((_pid, signal) => signals.push(signal)),
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			}),
		).rejects.toThrow("unauthorized");
		expect(signals).toEqual([]);
		expect(spawns).toBe(0);
	});

	test("does not signal after the owner changes before TERM", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.slack.botToken": "slack-token",
				"notifications.slack.appToken": "app-token",
				"notifications.slack.workspaceId": "workspace",
				"notifications.slack.channelId": "channel",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["slack-token", "app-token", "workspace", "channel", "", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "slack");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "slack",
				pid: 78,
				ownerId: "owner-a",
				identity,
				incarnation: "linux:12345",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration("slack"),
			}),
		);
		let reads = 0;
		const originalReadFile = fs.promises.readFile;
		fs.promises.readFile = (async (...args: Parameters<typeof fs.promises.readFile>) => {
			if (String(args[0]) === paths.state && ++reads === 2)
				return Buffer.from(
					JSON.stringify({
						version: 1,
						kind: "slack",
						pid: 78,
						ownerId: "owner-b",
						identity,
						incarnation: "linux:12345",
						startedAt: Date.now(),
						heartbeatAt: Date.now(),
						transportHealthy: true,
					}),
				);
			return await originalReadFile(...args);
		}) as typeof fs.promises.readFile;
		try {
			const result = await new ChatDaemonController(s, "slack", {
				pidAlive: () => true,
				pidIncarnation: () => "linux:12345",
				processReference: testChatProcessReference(() => {
					throw new Error("must not signal");
				}),
			}).stop();
			expect(result.ok).toBe(false);
			expect(result.message).toContain("ownership changed");
		} finally {
			fs.promises.readFile = originalReadFile;
		}
	});
	describe.each(["discord", "slack"] as const)("%s chat daemon generation", kind => {
		function configuredSettings(agentDir: string): Settings {
			return setPrivateAgentDir(
				Settings.isolated(
					kind === "discord"
						? {
								"notifications.enabled": true,
								"notifications.discord.botToken": "discord-token",
								"notifications.discord.applicationId": "app",
								"notifications.discord.guildId": "guild",
								"notifications.discord.parentChannelId": "parent",
							}
						: {
								"notifications.enabled": true,
								"notifications.slack.botToken": "slack-token",
								"notifications.slack.appToken": "app-token",
								"notifications.slack.workspaceId": "workspace",
								"notifications.slack.channelId": "channel",
							},
				) as Settings,
				agentDir,
			);
		}

		function identity(): string {
			const values =
				kind === "discord"
					? ["discord-token", "app", "guild", "parent", "false", "lean"]
					: ["slack-token", "app-token", "workspace", "channel", "", "false", "lean"];
			return crypto.createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 16);
		}

		test("never spawns a complete provider whose durable desired intent is off", async () => {
			const agentDir = tempAgentDir();
			const settings = configuredSettings(agentDir);
			settings.set(`notifications.${kind}.enabled`, false);
			let spawns = 0;
			const controller = new ChatDaemonController(settings, kind, {
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			});
			expect(await controller.ensure()).toBe("disabled");
			const result = await controller.reload();
			expect(result.ok).toBe(false);
			expect(result.message).toContain("not enabled");
			expect(spawns).toBe(0);
		});

		test("acknowledges an update-recovery restart while globally disabled without spawning delivery", async () => {
			const agentDir = tempAgentDir();
			const settings = configuredSettings(agentDir);
			settings.set("notifications.enabled", false);
			let spawns = 0;
			const controller = new ChatDaemonController(settings, kind, {
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			});
			const result = await controller.reload({ allowDisabledNoop: true });
			expect(result.ok).toBe(true);
			expect(result.message).toContain("leaving daemon stopped");
			expect(spawns).toBe(0);
		});

		test.each([
			["lower", chatDaemonGeneration(kind) - 1, "owner_spawned", "stale"],
			["equal", chatDaemonGeneration(kind), "attached", "running"],
			["legacy", undefined, "owner_spawned", "stale"],
			["newer", chatDaemonGeneration(kind) + 1, "attached", "running"],
		] as const)("%s generation replaces only compatible physical owners", async (_name, generation, expected, health) => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 91,
					ownerId: "owner-a",
					identity: identity(),
					incarnation: "linux:12345",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
					transportHealthy: true,
					...(generation === undefined ? {} : { generation }),
				}),
			);
			const alive = new Set([91]);
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => alive.has(pid),
				pidIncarnation: () => "linux:12345",
				sleep: async () => undefined,
				processReference: testChatProcessReference((_pid, signal) => {
					signals.push(signal);
					alive.delete(91);
				}),
				spawn: (_command, args) => {
					spawns++;
					const ownerId = args[args.indexOf("--owner-id") + 1];
					alive.add(92);
					fs.writeFileSync(
						paths.state,
						JSON.stringify({
							version: 1,
							kind,
							pid: 92,
							ownerId,
							identity: identity(),
							incarnation: "linux:12345",
							startedAt: Date.now(),
							heartbeatAt: Date.now(),
							transportHealthy: true,
							generation: chatDaemonGeneration(kind),
						}),
					);
					return { unref() {} };
				},
			});
			expect((await controller.status()).health).toBe(health);
			expect(await controller.ensure()).toBe(expected);
			expect(signals).toEqual(expected === "attached" ? [] : ["SIGTERM"]);
			expect(spawns).toBe(expected === "attached" ? 0 : 1);
		});

		test("attaches when a newer-generation owner becomes healthy during the wait", async () => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			const state = {
				version: 1,
				kind,
				pid: 91,
				ownerId: "owner-a",
				identity: identity(),
				incarnation: "linux:12345",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: false,
				generation: chatDaemonGeneration(kind) + 1,
			};
			fs.writeFileSync(paths.state, JSON.stringify(state));
			let sleeps = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => pid === 91,
				pidIncarnation: () => "linux:12345",
				sleep: async () => {
					if (++sleeps === 1) fs.writeFileSync(paths.state, JSON.stringify({ ...state, transportHealthy: true }));
				},
			});
			expect(await controller.ensure()).toBe("attached");
			expect(sleeps).toBe(1);
		});

		test.each([
			["version", 2],
			["kind", "telegram"],
			["pid", 0],
			["ownerId", ""],
			["identity", ""],
			["incarnation", ""],
			["incarnation", "unavailable"],
			["startedAt", "now"],
			["heartbeatAt", Number.NaN],
			["transportHealthy", "true"],
			["generation", "1"],
			["stoppedAt", "truthy-nonnumeric"],
		] as const)("fails closed for malformed live state field: %s", async (field, value) => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			const state = {
				version: 1,
				kind,
				pid: 93,
				ownerId: "owner-a",
				identity: identity(),
				incarnation: "linux:12345",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration(kind),
				[field]: value,
			};
			expect(hasSafeChatDaemonStateShape(state)).toBe(false);
			fs.writeFileSync(paths.state, JSON.stringify(state));
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => pid === 93,
				pidIncarnation: () => "linux:12345",
				processReference: testChatProcessReference((_pid, signal) => signals.push(signal)),
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			});
			expect((await controller.status()).health).toBe("stale");
			await expect(controller.ensure()).rejects.toThrow("unauthorized");
			expect((await controller.stop()).ok).toBe(false);
			expect((await controller.reload()).ok).toBe(false);
			expect(signals).toEqual([]);
			expect(spawns).toBe(0);
		});

		test("recovers only a dead pre-upgrade unavailable owner and replaces its lock", async () => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 96,
					ownerId: "legacy-owner",
					identity: identity(),
					incarnation: "unavailable",
					startedAt: 1,
					heartbeatAt: 1,
					transportHealthy: false,
				}),
			);
			fs.writeFileSync(paths.lock, JSON.stringify({ pid: 96, incarnation: "unavailable", createdAt: 1 }));
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => pid === 97,
				pidIncarnation: pid => (pid === 97 || pid === process.pid ? "linux:12352" : undefined),
				spawn: (_command, args) => {
					spawns++;
					void (async () => {
						const acquired = await acquireChatDaemonOwnership({
							agentDir,
							kind,
							ownerId: args[args.indexOf("--owner-id") + 1],
							pid: 97,
							identity: identity(),
							incarnation: "linux:12352",
							pidAlive: pid => pid === 97,
							pidIncarnation: pid => (pid === 97 || pid === process.pid ? "linux:12352" : undefined),
						});
						if (!acquired) return;
						const owner = JSON.parse(fs.readFileSync(paths.state, "utf8"));
						fs.writeFileSync(
							paths.state,
							JSON.stringify({ ...owner, heartbeatAt: Date.now(), transportHealthy: true }),
						);
					})();
					return { unref() {} };
				},
			});
			expect(await controller.ensure()).toBe("owner_spawned");
			expect(spawns).toBe(1);
			expect(JSON.parse(fs.readFileSync(paths.state, "utf8"))).toMatchObject({
				pid: 97,
				incarnation: "linux:12352",
			});
			expect(JSON.parse(fs.readFileSync(paths.lock, "utf8"))).toMatchObject({ pid: 97, incarnation: "linux:12352" });
		});

		test("fails closed for a live pre-upgrade unavailable owner with ambiguous provenance", async () => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			const legacyState = {
				version: 1,
				kind,
				pid: 96,
				ownerId: "legacy-owner",
				identity: identity(),
				incarnation: "unavailable",
				startedAt: 1,
				heartbeatAt: 1,
				transportHealthy: false,
			};
			fs.writeFileSync(paths.state, JSON.stringify(legacyState));
			fs.writeFileSync(paths.lock, JSON.stringify({ pid: 96, incarnation: "unavailable", createdAt: 1 }));
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => pid === 96,
				pidIncarnation: () => undefined,
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			});
			expect((await controller.status()).health).toBe("stale");
			await expect(controller.ensure()).rejects.toThrow("unauthorized");
			expect(spawns).toBe(0);
			expect(JSON.parse(fs.readFileSync(paths.state, "utf8"))).toEqual(legacyState);
			expect(JSON.parse(fs.readFileSync(paths.lock, "utf8"))).toMatchObject({ pid: 96, incarnation: "unavailable" });
		});

		test("fails closed without signaling a malformed generation", async () => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 91,
					ownerId: "owner-a",
					identity: identity(),
					incarnation: "linux:12345",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
					transportHealthy: true,
					generation: null,
				}),
			);
			const signals: NodeJS.Signals[] = [];
			await expect(
				new ChatDaemonController(configuredSettings(agentDir), kind, {
					pidAlive: () => true,
					pidIncarnation: () => "linux:12345",
					processReference: testChatProcessReference((_pid, signal) => signals.push(signal)),
				}).ensure(),
			).rejects.toThrow("unauthorized");
			expect(signals).toEqual([]);
		});

		test.each([
			["negative", -1, identity()],
			["non-safe", Number.MAX_SAFE_INTEGER + 1, identity()],
			["non-number", "1", identity()],
			["different identity", chatDaemonGeneration(kind), "other-identity"],
		] as const)("fails closed for every public operation: %s", async (_name, generation, stateIdentity) => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 94,
					ownerId: "owner-a",
					identity: stateIdentity,
					incarnation: "linux:12345",
					startedAt: Date.now(),
					heartbeatAt: 1,
					transportHealthy: false,
					generation,
				}),
			);
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => pid === 94,
				pidIncarnation: () => "linux:12345",
				processReference: testChatProcessReference((_pid, signal) => signals.push(signal)),
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			});
			await expect(controller.ensure()).rejects.toThrow("unauthorized");
			expect((await controller.stop()).ok).toBe(false);
			expect((await controller.reload()).ok).toBe(false);
			expect(signals).toEqual([]);
			expect(spawns).toBe(0);
		});

		test.each([
			["ensure after dead valid state", "ensure", chatDaemonGeneration(kind), identity(), false],
			["reload after safely stopped state", "reload", chatDaemonGeneration(kind), identity(), true],
			["ensure after dead different identity", "ensure", chatDaemonGeneration(kind), "other-identity", false],
			["reload after stopped different identity", "reload", chatDaemonGeneration(kind), "other-identity", true],
		] as const)("spawns fresh for %s persisted state", async (_name, action, generation, stateIdentity, stopped) => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 96,
					ownerId: "dead-owner",
					identity: stateIdentity,
					incarnation: "linux:12351",
					startedAt: Date.now(),
					heartbeatAt: 1,
					transportHealthy: false,
					generation,
					...(stopped ? { stoppedAt: Date.now() } : {}),
				}),
			);
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => pid === 97,
				pidIncarnation: pid => (pid === 97 ? "linux:12352" : undefined),
				processReference: testChatProcessReference((_pid, signal) => signals.push(signal)),
				spawn: (_command, args) => {
					spawns++;
					fs.writeFileSync(
						paths.state,
						JSON.stringify({
							version: 1,
							kind,
							pid: 97,
							ownerId: args[args.indexOf("--owner-id") + 1],
							identity: identity(),
							incarnation: "linux:12352",
							startedAt: Date.now(),
							heartbeatAt: Date.now(),
							transportHealthy: true,
							generation: chatDaemonGeneration(kind),
						}),
					);
					return { unref() {} };
				},
			});
			if (action === "ensure") expect(await controller.ensure()).toBe("owner_spawned");
			else expect((await controller.reload()).ok).toBe(true);
			expect(signals).toEqual([]);
			expect(spawns).toBe(1);
		});

		test.each([
			["lower", chatDaemonGeneration(kind) - 1, "stop"],
			["lower", chatDaemonGeneration(kind) - 1, "reload"],
		] as const)("signals matching unhealthy legacy owners for %s %s", async (_name, generation, action) => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 94,
					ownerId: "owner-a",
					identity: identity(),
					incarnation: "linux:12345",
					startedAt: Date.now(),
					heartbeatAt: 1,
					transportHealthy: false,
					...(generation === undefined ? {} : { generation }),
				}),
			);
			const alive = new Set([94]);
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => alive.has(pid),
				pidIncarnation: () => "linux:12345",
				sleep: async () => undefined,
				processReference: testChatProcessReference((_pid, signal) => {
					signals.push(signal);
					alive.delete(94);
				}),
				spawn: (_command, args) => {
					spawns++;
					alive.add(95);
					fs.writeFileSync(
						paths.state,
						JSON.stringify({
							version: 1,
							kind,
							pid: 95,
							ownerId: args[args.indexOf("--owner-id") + 1],
							identity: identity(),
							incarnation: "linux:12345",
							startedAt: Date.now(),
							heartbeatAt: Date.now(),
							transportHealthy: true,
							generation: chatDaemonGeneration(kind),
						}),
					);
					return { unref() {} };
				},
			});
			const result = await controller[action]();
			expect(result.ok).toBe(true);
			expect(signals).toEqual(["SIGTERM"]);
			expect(spawns).toBe(action === "reload" ? 1 : 0);
		});

		test.each([
			"stop",
			"reload",
		] as const)("refuses %s of a live newer owner without changing its state", async action => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			const state = {
				version: 1,
				kind,
				pid: 95,
				ownerId: "newer-owner",
				identity: identity(),
				incarnation: "linux:12346",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration(kind) + 1,
			};
			const serializedState = JSON.stringify(state);
			fs.writeFileSync(paths.state, serializedState);
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const result = await new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => pid === state.pid,
				pidIncarnation: () => state.incarnation,
				processReference: testChatProcessReference((_pid, signal) => signals.push(signal)),
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			})[action]();
			expect(result.ok).toBe(false);
			expect(result.message).toContain("newer than this controller");
			expect(result.message).toContain("upgrade this controller");
			expect(signals).toEqual([]);
			expect(spawns).toBe(0);
			expect(fs.readFileSync(paths.state, "utf8")).toBe(serializedState);
		});

		test("refuses replacement when the captured generation changes before TERM", async () => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			const state = {
				version: 1,
				kind,
				pid: 92,
				ownerId: "owner-a",
				identity: identity(),
				incarnation: "linux:12345",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration(kind),
			};
			fs.writeFileSync(paths.state, JSON.stringify(state));
			let reads = 0;
			const originalReadFile = fs.promises.readFile;
			fs.promises.readFile = (async (...args: Parameters<typeof fs.promises.readFile>) => {
				if (String(args[0]) === paths.state && ++reads === 3)
					return Buffer.from(JSON.stringify({ ...state, generation: chatDaemonGeneration(kind) + 1 }));
				return await originalReadFile(...args);
			}) as typeof fs.promises.readFile;
			try {
				const signals: NodeJS.Signals[] = [];
				const result = await new ChatDaemonController(configuredSettings(agentDir), kind, {
					pidAlive: pid => pid === 92,
					pidIncarnation: () => "linux:12345",
					processReference: testChatProcessReference((_pid, signal) => signals.push(signal)),
				}).stop();
				expect(result.ok).toBe(false);
				expect(result.message).toContain("ownership changed");
				expect(signals).toEqual([]);
			} finally {
				fs.promises.readFile = originalReadFile;
			}
		});
	});
});

describe("Chat daemon owner-lock publication", () => {
	test("a paused owner publisher cannot reclaim or overwrite a published contender", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const originalLink = fs.promises.link;
		let paused = false;
		fs.promises.link = (async (...args: Parameters<typeof fs.promises.link>) => {
			if (!paused && args[1] === paths.lock) {
				paused = true;
				entered.resolve();
				await release.promise;
			}
			return await originalLink(...args);
		}) as typeof fs.promises.link;
		try {
			const probe = { pidAlive: () => true, pidIncarnation: () => "linux:12350" };
			const first = acquireChatDaemonOwnership({
				agentDir,
				kind: "discord",
				ownerId: "owner-a",
				pid: process.pid,
				identity: "identity",
				incarnation: "linux:12350",
				...probe,
			});
			await entered.promise;
			const second = acquireChatDaemonOwnership({
				agentDir,
				kind: "discord",
				ownerId: "owner-b",
				pid: process.pid,
				identity: "identity",
				incarnation: "linux:12350",
				...probe,
			});
			await Bun.sleep(100);
			release.resolve();
			expect(await first).toBe(true);
			expect(await second).toBe(false);
			expect(JSON.parse(fs.readFileSync(paths.state, "utf8")).ownerId).toBe("owner-a");
		} finally {
			fs.promises.link = originalLink;
		}
	});

	test("fails closed without immutable process-incarnation authority", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		expect(
			await acquireChatDaemonOwnership({
				agentDir,
				kind: "discord",
				ownerId: "owner",
				pid: 91,
				identity: "identity",
				pidAlive: () => true,
				pidIncarnation: () => undefined,
			}),
		).toBe(false);
		expect(fs.existsSync(paths.lock)).toBe(false);
		expect(fs.existsSync(paths.state)).toBe(false);
	});

	test("recovers a dead recorded owner lock", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "slack");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(paths.lock, JSON.stringify({ pid: 2_147_483_647, incarnation: "old", createdAt: 1 }));
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "slack",
				pid: 2_147_483_647,
				ownerId: "old",
				identity: "old",
				incarnation: "old",
				startedAt: 1,
				heartbeatAt: 1,
			}),
		);
		expect(
			await acquireChatDaemonOwnership({
				agentDir,
				kind: "slack",
				ownerId: "new",
				pid: process.pid,
				identity: "identity",
				incarnation: "linux:12350",
			}),
		).toBe(true);
		expect(JSON.parse(fs.readFileSync(paths.state, "utf8")).ownerId).toBe("new");
	});

	test("recovers a crashed reclaim owner with a reused PID incarnation", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		const crashedOwner = { pid: 91, incarnation: "linux:12348", createdAt: 1 };
		fs.writeFileSync(paths.lock, JSON.stringify(crashedOwner));
		fs.writeFileSync(`${paths.lock}.reclaim`, JSON.stringify(crashedOwner));
		const probe = {
			pidAlive: (pid: number) => pid === 91,
			pidIncarnation: (pid: number) => (pid === 91 ? "linux:12349" : "linux:12350"),
		};

		expect(
			await acquireChatDaemonOwnership({
				agentDir,
				kind: "discord",
				ownerId: "new",
				pid: 92,
				identity: "identity",
				incarnation: "linux:12347",
				...probe,
			}),
		).toBe(true);
		expect(JSON.parse(fs.readFileSync(paths.state, "utf8")).ownerId).toBe("new");
		expect(fs.existsSync(`${paths.lock}.reclaim`)).toBe(false);
	});

	test("a completed reclaimer cannot delete a successor owner lock", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		const stale = JSON.stringify({ pid: 91, incarnation: "linux:stale", createdAt: 1 });
		fs.writeFileSync(paths.lock, stale);
		fs.writeFileSync(`${paths.lock}.reclaim`, stale);
		const probe = {
			pidAlive: (pid: number) => pid !== 91,
			pidIncarnation: (pid: number) => (pid === 91 ? "linux:replacement" : "linux:12350"),
		};
		const delayedClaim = await acquireChatDaemonOwnership({
			agentDir,
			kind: "discord",
			ownerId: "delayed",
			pid: 92,
			identity: "identity",
			incarnation: "linux:12350",
			...probe,
		});
		expect(delayedClaim).toBe(true);
		const successor = await acquireChatDaemonOwnership({
			agentDir,
			kind: "discord",
			ownerId: "successor",
			pid: 93,
			identity: "identity",
			incarnation: "linux:12350",
			...probe,
		});
		expect(successor).toBe(false);
		expect(JSON.parse(fs.readFileSync(paths.state, "utf8")).ownerId).toBe("delayed");
		expect(JSON.parse(fs.readFileSync(paths.lock, "utf8")).pid).toBe(92);
	});

	test("does not steal a fresh reclaim lock owned by a live incarnation", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "slack");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(paths.lock, JSON.stringify({ pid: 82, incarnation: "darwin:1700000000:999999", createdAt: 1 }));
		const liveReclaim = `${JSON.stringify({ pid: 81, incarnation: "darwin:1700000000:123456", createdAt: Date.now() })}\n`;
		fs.writeFileSync(`${paths.lock}.reclaim`, liveReclaim);
		const probe = {
			pidAlive: (pid: number) => pid === 81,
			pidIncarnation: (pid: number) => (pid === 81 ? "darwin:1700000000:123456" : undefined),
		};

		expect(
			await acquireChatDaemonOwnership({
				agentDir,
				kind: "slack",
				ownerId: "new",
				pid: 83,
				identity: "identity",
				incarnation: "linux:12347",
				...probe,
			}),
		).toBe(false);
		expect(fs.readFileSync(paths.lock, "utf8")).toContain("82");
		expect(fs.readFileSync(`${paths.lock}.reclaim`, "utf8")).toBe(liveReclaim);
	});
});

test("configured chat providers auto-start while incomplete providers do not", async () => {
	const agentDir = tempAgentDir();
	const configured = setPrivateAgentDir(
		Settings.isolated({
			"notifications.enabled": true,
			"notifications.discord.botToken": "discord-token",
			"notifications.discord.applicationId": "app",
			"notifications.discord.guildId": "guild",
			"notifications.discord.parentChannelId": "parent",
		}) as Settings,
		agentDir,
	);
	let spawns = 0;
	const paths = chatDaemonPaths(agentDir, "discord");
	expect(
		await ensureDiscordDaemon(configured, {
			pidIncarnation: () => "linux:12345",
			spawn: (_command, args) => {
				spawns++;
				fs.mkdirSync(paths.dir, { recursive: true });
				fs.writeFileSync(
					paths.state,
					JSON.stringify({
						version: 1,
						kind: "discord",
						pid: process.pid,
						ownerId: args[args.indexOf("--owner-id") + 1],
						identity: crypto
							.createHash("sha256")
							.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
							.digest("hex")
							.slice(0, 16),
						incarnation: "linux:12345",
						startedAt: Date.now(),
						heartbeatAt: Date.now(),
						transportHealthy: true,
						generation: chatDaemonGeneration("discord"),
					}),
				);
				return { unref() {} };
			},
		}),
	).toBe("owner_spawned");
	expect(spawns).toBe(1);
	const incomplete = setPrivateAgentDir(
		Settings.isolated({ "notifications.enabled": true, "notifications.slack.botToken": "bot" }) as Settings,
		tempAgentDir(),
	);
	expect(
		await ensureSlackDaemon(incomplete, {
			spawn: () => {
				throw new Error("must not spawn");
			},
		}),
	).toBe("disabled");
});

describe("runChatDaemonInternal heartbeat ownership", () => {
	function writeChatDaemonConfig(agentDir: string): void {
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			[
				"notifications:",
				"  enabled: true",
				"  discord:",
				"    botToken: discord-token",
				"    applicationId: app",
				"    guildId: guild",
				"    parentChannelId: parent",
				"",
			].join("\n"),
		);
	}

	function workerArgs(agentDir: string): string[] {
		return ["--agent-dir", agentDir, "--owner-id", `${process.pid}-heartbeat-test`];
	}

	test.each([
		["EPERM", "operation not permitted"],
		[undefined, "probe authority unavailable"],
	] as const)("retains launcher ownership when the default probe returns %s", async (code, message) => {
		const agentDir = tempAgentDir();
		writeChatDaemonConfig(agentDir);
		const kill = spyOn(process, "kill").mockImplementation(() => {
			const error = new Error(message) as NodeJS.ErrnoException;
			if (code) error.code = code;
			throw error;
		});
		let constructed = false;
		try {
			await runChatDaemonInternal("discord", workerArgs(agentDir), {
				pidIncarnation: () => "linux:12345",
				createRuntime: () => {
					constructed = true;
					return { start: async () => undefined, stop: async () => undefined };
				},
				renewHeartbeat: async () => false,
			});
			expect(constructed).toBe(true);
		} finally {
			kill.mockRestore();
		}
	});

	test("returns before constructing the runtime when the default launcher probe returns ESRCH", async () => {
		const agentDir = tempAgentDir();
		writeChatDaemonConfig(agentDir);
		const kill = spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("no such process"), { code: "ESRCH" });
		});
		let constructed = false;
		try {
			await runChatDaemonInternal("discord", workerArgs(agentDir), {
				createRuntime: () => {
					constructed = true;
					throw new Error("runtime should not be constructed");
				},
			});
			expect(constructed).toBe(false);
		} finally {
			kill.mockRestore();
		}
	});

	test("returns cleanly without constructing a desired-off provider runtime", async () => {
		const agentDir = tempAgentDir();
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			[
				"notifications:",
				"  enabled: true",
				"  discord:",
				"    enabled: false",
				"    botToken: discord-token",
				"    applicationId: app",
				"    guildId: guild",
				"    parentChannelId: parent",
				"",
			].join("\n"),
		);
		let constructed = false;
		await runChatDaemonInternal("discord", workerArgs(agentDir), {
			createRuntime: () => {
				constructed = true;
				throw new Error("runtime should not be constructed");
			},
		});
		expect(constructed).toBe(false);
	});

	test("does not start the transport when its initial heartbeat renewal fails", async () => {
		const agentDir = tempAgentDir();
		writeChatDaemonConfig(agentDir);
		let started = 0;
		let stopped = 0;
		await runChatDaemonInternal("discord", workerArgs(agentDir), {
			createRuntime: () => ({
				start: async () => {
					started++;
				},
				stop: async () => {
					stopped++;
				},
			}),
			renewHeartbeat: async () => false,
		});
		expect(started).toBe(0);
		expect(stopped).toBe(1);
	});

	test("stops before serving when its initial heartbeat renewal rejects", async () => {
		const agentDir = tempAgentDir();
		writeChatDaemonConfig(agentDir);
		let started = 0;
		let stopped = 0;
		await expect(
			runChatDaemonInternal("discord", workerArgs(agentDir), {
				createRuntime: () => ({
					start: async () => {
						started++;
					},
					stop: async () => {
						stopped++;
					},
				}),
				renewHeartbeat: async () => {
					throw new Error("heartbeat write failed");
				},
			}),
		).rejects.toThrow("heartbeat write failed");
		expect(started).toBe(0);
		expect(stopped).toBe(1);
	});

	async function expectLaterHeartbeatFailureStopsTransport(
		renewHeartbeat: (call: number) => Promise<boolean>,
		expectedTerminalError?: string,
		stopError?: string,
	): Promise<void> {
		const agentDir = tempAgentDir();
		writeChatDaemonConfig(agentDir);
		let intervalCallback: (() => void) | undefined;
		const started = Promise.withResolvers<void>();
		const intervalReady = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		let stops = 0;
		let clearCalls = 0;
		let renewals = 0;
		const worker = runChatDaemonInternal("discord", workerArgs(agentDir), {
			createRuntime: () => ({
				start: async () => started.resolve(),
				stop: async () => {
					stops++;
					stopped.resolve();
					if (stopError) throw new Error(stopError);
				},
			}),
			renewHeartbeat: async () => await renewHeartbeat(++renewals),
			setInterval: ((callback: () => void) => {
				intervalCallback = callback;
				intervalReady.resolve();
				return 1 as unknown as ReturnType<typeof setInterval>;
			}) as typeof setInterval,
			clearInterval: () => {
				clearCalls++;
			},
		});
		await started.promise;
		await intervalReady.promise;
		expect(intervalCallback).toBeDefined();
		intervalCallback?.();
		await stopped.promise;
		if (expectedTerminalError === undefined) await worker;
		else await expect(worker).rejects.toThrow(expectedTerminalError);
		expect(stops).toBe(1);
		expect(clearCalls).toBe(1);
	}

	test("stops the transport when a later renewal loses ownership", async () => {
		await expectLaterHeartbeatFailureStopsTransport(async call => call === 1);
	});

	test("stops the transport when a later heartbeat persistence attempt rejects", async () => {
		await expectLaterHeartbeatFailureStopsTransport(async call => {
			if (call === 1) return true;
			throw new Error("heartbeat write failed");
		}, "heartbeat write failed");
	});

	test("surfaces a later runtime-stop rejection after ownership-loss cleanup", async () => {
		await expectLaterHeartbeatFailureStopsTransport(
			async call => call === 1,
			"transport stop failed",
			"transport stop failed",
		);
	});
});

describe("runChatDaemonInternal retires when notifications are disabled", () => {
	type Kind = "discord" | "slack";
	type ConfigVariant = "enabled" | "provider-disabled" | "global-disabled";

	function writeConfig(agentDir: string, kind: Kind, variant: ConfigVariant): void {
		const providerOff = variant === "provider-disabled" ? ["    enabled: false"] : [];
		const provider =
			kind === "discord"
				? [
						"  discord:",
						...providerOff,
						"    botToken: discord-token",
						"    applicationId: app",
						"    guildId: guild",
						"    parentChannelId: parent",
					]
				: [
						"  slack:",
						...providerOff,
						"    botToken: xoxb-slack-token",
						"    appToken: xapp-slack-token",
						"    workspaceId: T123",
						"    channelId: C123",
					];
		const globalEnabled = variant === "global-disabled" ? "false" : "true";
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			["notifications:", `  enabled: ${globalEnabled}`, ...provider, ""].join("\n"),
		);
	}

	function writeHalfWrittenConfig(agentDir: string): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), "notifications:\n  enabled: [\n");
	}

	interface Harness {
		ownerId: string;
		worker: Promise<void>;
		tick(): Promise<void>;
		stops(): number;
	}

	async function startWorker(
		agentDir: string,
		kind: Kind,
		label: string,
		pidIncarnation?: (pid: number) => string | undefined,
	): Promise<Harness> {
		const ownerId = `${process.pid}-retire-${label}`;
		let intervalCallback: (() => unknown) | undefined;
		const started = Promise.withResolvers<void>();
		const intervalReady = Promise.withResolvers<void>();
		let stops = 0;
		const worker = runChatDaemonInternal(kind, ["--agent-dir", agentDir, "--owner-id", ownerId], {
			pidIncarnation,
			createRuntime: () => ({
				start: async () => started.resolve(),
				stop: async () => {
					stops++;
				},
			}),
			renewHeartbeat: async () => true,
			setInterval: ((callback: () => unknown) => {
				intervalCallback = callback;
				intervalReady.resolve();
				return 1 as unknown as ReturnType<typeof setInterval>;
			}) as unknown as typeof setInterval,
			clearInterval: () => undefined,
		});
		await started.promise;
		await intervalReady.promise;
		return {
			ownerId,
			worker,
			tick: async () => {
				await intervalCallback?.();
			},
			stops: () => stops,
		};
	}

	async function expectServing(harness: Harness): Promise<void> {
		const settled = await Promise.race([harness.worker.then(() => "exited"), Bun.sleep(250).then(() => "serving")]);
		expect(settled).toBe("serving");
		expect(harness.stops()).toBe(0);
	}

	async function expectRetired(agentDir: string, kind: Kind, harness: Harness): Promise<void> {
		await harness.worker;
		expect(harness.stops()).toBe(1);
		const state = await readChatDaemonState(agentDir, kind);
		expect(state?.ownerId).toBe(harness.ownerId);
		expect(state?.stoppedAt).toBeNumber();
		// Credentials stay configured while the provider is switched off, as on a real install.
		const disabled = setPrivateAgentDir(
			Settings.isolated(
				kind === "discord"
					? {
							"notifications.enabled": false,
							"notifications.discord.botToken": "discord-token",
							"notifications.discord.applicationId": "app",
							"notifications.discord.guildId": "guild",
							"notifications.discord.parentChannelId": "parent",
						}
					: {
							"notifications.enabled": false,
							"notifications.slack.botToken": "xoxb-slack-token",
							"notifications.slack.appToken": "xapp-slack-token",
							"notifications.slack.workspaceId": "T123",
							"notifications.slack.channelId": "C123",
						},
			),
			agentDir,
		);
		// The worker process exits once runChatDaemonInternal returns; model that exit.
		const status = await new ChatDaemonController(disabled, kind, { pidAlive: () => false }).status();
		expect(status.health).toBe("stopped");
	}

	test.each([
		["slack", "provider-disabled"],
		["slack", "global-disabled"],
		["discord", "provider-disabled"],
		["discord", "global-disabled"],
	] as const)("%s owner retires after the config becomes %s", async (kind, variant) => {
		const agentDir = tempAgentDir();
		writeConfig(agentDir, kind, "enabled");
		const harness = await startWorker(agentDir, kind, `${kind}-${variant}`);
		await harness.tick();
		await harness.tick();
		await expectServing(harness);

		writeConfig(agentDir, kind, variant);
		await harness.tick();
		await harness.tick();
		await expectRetired(agentDir, kind, harness);

		// Re-enabling lets a fresh owner acquire the retired slot and serve again.
		writeConfig(agentDir, kind, "enabled");
		// This test process stands in for both daemons, so give the successor a distinct
		// process incarnation, as a freshly spawned worker would have.
		const successor = await startWorker(agentDir, kind, `${kind}-${variant}-successor`, () => "linux:424242");
		const successorState = await readChatDaemonState(agentDir, kind);
		expect(successorState?.ownerId).toBe(successor.ownerId);
		expect(successorState?.stoppedAt).toBeUndefined();
		await expectServing(successor);
		writeConfig(agentDir, kind, variant);
		await successor.tick();
		await successor.tick();
		await expectRetired(agentDir, kind, successor);
	});

	test("keeps serving through unreadable config and isolated disabled reads", async () => {
		const agentDir = tempAgentDir();
		writeConfig(agentDir, "slack", "enabled");
		const harness = await startWorker(agentDir, "slack", "transient");

		// A half-written / unparsable file is a read error, never a disabled verdict.
		writeHalfWrittenConfig(agentDir);
		await harness.tick();
		await harness.tick();
		await harness.tick();
		await expectServing(harness);

		// One disabled read between enabled or unreadable reads is not a settled verdict.
		writeConfig(agentDir, "slack", "provider-disabled");
		await harness.tick();
		writeConfig(agentDir, "slack", "enabled");
		await harness.tick();
		writeConfig(agentDir, "slack", "global-disabled");
		await harness.tick();
		writeHalfWrittenConfig(agentDir);
		await harness.tick();
		await expectServing(harness);
		expect((await readChatDaemonState(agentDir, "slack"))?.stoppedAt).toBeUndefined();

		writeConfig(agentDir, "slack", "provider-disabled");
		await harness.tick();
		await harness.tick();
		await expectRetired(agentDir, "slack", harness);
	});
});
