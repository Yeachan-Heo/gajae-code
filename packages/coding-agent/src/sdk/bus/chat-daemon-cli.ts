import * as crypto from "node:crypto";
import * as path from "node:path";
import {
	acquireChatDaemonOwnership,
	type ChatDaemonKind,
	clearChatDaemonControlRequest,
	readChatDaemonControlRequest,
	readChatDaemonState,
	releaseChatDaemonOwnership,
	renewChatDaemonHeartbeat,
} from "./chat-daemon-control";
import { type ChatDaemonRuntimeConfig, ChatDaemonRuntime as DefaultChatDaemonRuntime } from "./chat-daemon-runtime";
import {
	isDiscordConfigured,
	isSlackConfigured,
	loadNotificationConfigFile,
	notificationConfigFromFile,
} from "./config";

export interface ChatDaemonRuntimeHandle {
	start(): Promise<void>;
	stop(): Promise<void>;
	transportHealthy?(): boolean;
}

export interface RunChatDaemonInternalDeps {
	processPid?: number;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
	createRuntime?: (input: {
		kind: ChatDaemonKind;
		agentDir: string;
		config: ChatDaemonConfig;
	}) => Promise<ChatDaemonRuntimeHandle> | ChatDaemonRuntimeHandle;
	renewHeartbeat?: (input: Parameters<typeof renewChatDaemonHeartbeat>[0]) => Promise<boolean>;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
}

export type ChatDaemonConfig = ChatDaemonRuntimeConfig;

function argValue(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function loadConfig(agentDir: string, kind: ChatDaemonKind): Promise<ChatDaemonConfig | undefined> {
	const loaded = loadNotificationConfigFile(agentDir);
	if (loaded.status === "not-found") return undefined;
	if (loaded.status === "error") throw loaded.error;
	const config = notificationConfigFromFile(loaded.value);
	if (!config.enabled) return undefined;
	if (kind === "discord") {
		if (
			!isDiscordConfigured({
				...config,
				sessionScope: "all",
				idleTimeoutMs: 60_000,
				rich: { enabled: true },
				richDraft: { enabled: false },
				toolActivity: { enabled: true },
				topics: { nameTemplate: undefined },
				btw: { enabled: true },
				streaming: { enabled: true },
			})
		) {
			throw new Error("Discord notifications are enabled but configuration is incomplete");
		}
		const discord = config.discord as {
			botToken: string;
			applicationId: string;
			guildId: string;
			parentChannelId: string;
		};
		const { botToken, applicationId, guildId, parentChannelId } = discord;
		const identity = crypto
			.createHash("sha256")
			.update(
				[botToken, applicationId, guildId, parentChannelId, String(config.redact), config.verbosity].join("\0"),
			)
			.digest("hex")
			.slice(0, 16);
		return {
			identity,
			notifications: { discord: { botToken, applicationId, guildId, parentChannelId } },
			presentation: { redact: config.redact, verbosity: config.verbosity },
		};
	}
	if (
		!isSlackConfigured({
			...config,
			sessionScope: "all",
			idleTimeoutMs: 60_000,
			rich: { enabled: true },
			richDraft: { enabled: false },
			toolActivity: { enabled: true },
			topics: { nameTemplate: undefined },
			btw: { enabled: true },
			streaming: { enabled: true },
		})
	) {
		throw new Error("Slack notifications are enabled but configuration is incomplete");
	}
	const slack = config.slack as {
		botToken: string;
		appToken: string;
		workspaceId: string;
		channelId: string;
		authorizedUserId?: string;
	};
	const { botToken, appToken, workspaceId, channelId, authorizedUserId } = slack;
	const identity = crypto
		.createHash("sha256")
		.update(
			[
				botToken,
				appToken,
				workspaceId,
				channelId,
				authorizedUserId ?? "",
				String(config.redact),
				config.verbosity,
			].join("\0"),
		)
		.digest("hex")
		.slice(0, 16);
	return {
		identity,
		notifications: { slack: { botToken, appToken, workspaceId, channelId, authorizedUserId } },
		presentation: { redact: config.redact, verbosity: config.verbosity },
	};
}

function ownerPid(ownerId: string): number | undefined {
	const match = /^(\d+)(?:-|$)/.exec(ownerId);
	const pid = Number(match?.[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function defaultRuntime(input: {
	kind: ChatDaemonKind;
	agentDir: string;
	config: ChatDaemonConfig;
}): ChatDaemonRuntimeHandle {
	return new DefaultChatDaemonRuntime(input);
}

/** Hidden worker entrypoint. It owns only lock/state/control lifecycle; transport creation remains injectable. */
export async function runChatDaemonInternal(
	kind: ChatDaemonKind,
	argv: string[],
	deps: RunChatDaemonInternalDeps = {},
): Promise<void> {
	const agentDir =
		argValue(argv, "--agent-dir") ?? process.env.GJC_CODING_AGENT_DIR ?? path.join(process.cwd(), ".gjc", "agent");
	const ownerId = argValue(argv, "--owner-id");
	if (!ownerId) throw new Error("missing --owner-id");
	const pid = ownerPid(ownerId);
	if (pid !== undefined && !(deps.pidAlive ?? defaultPidAlive)(pid)) return;
	const daemonPid = deps.processPid ?? process.pid;
	const config = await loadConfig(agentDir, kind);
	if (!config) return;
	if (
		!(await acquireChatDaemonOwnership({
			agentDir,
			kind,
			ownerId,
			pid: daemonPid,
			identity: config.identity,
			pidAlive: deps.pidAlive,
			pidIncarnation: deps.pidIncarnation,
		}))
	)
		return;

	let incarnation: string | undefined;
	let runtime: ChatDaemonRuntimeHandle | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let stopping = false;
	let terminalError: unknown;
	let runtimeStop: Promise<void> | undefined;
	const stopRuntime = (): Promise<void> => {
		runtimeStop ??= runtime?.stop() ?? Promise.resolve();
		return runtimeStop;
	};
	const stop = (): void => {
		stopping = true;
		void stopRuntime().catch(error => {
			terminalError ??= error;
		});
	};
	try {
		incarnation = (await readChatDaemonState(agentDir, kind))?.incarnation;
		if (!incarnation) throw new Error("chat daemon ownership state is missing an incarnation");
		runtime = await (deps.createRuntime?.({ kind, agentDir, config }) ?? defaultRuntime({ kind, agentDir, config }));
		const activeRuntime = runtime;
		const renewHeartbeat = async (): Promise<boolean> =>
			await (deps.renewHeartbeat ?? renewChatDaemonHeartbeat)({
				agentDir,
				kind,
				ownerId,
				pid: daemonPid,
				incarnation,
				transportHealthy: activeRuntime.transportHealthy?.() ?? true,
				pidAlive: deps.pidAlive,
				pidIncarnation: deps.pidIncarnation,
			});
		const terminateForLostOwnership = async (): Promise<void> => {
			stopping = true;
			await stopRuntime();
		};
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		if (!(await renewHeartbeat())) {
			await terminateForLostOwnership();
			return;
		}
		await runtime.start();
		interval = (deps.setInterval ?? setInterval)(() => {
			void (async () => {
				try {
					if (!(await renewHeartbeat())) await terminateForLostOwnership();
				} catch (error) {
					terminalError ??= error;
					stopping = true;
					try {
						await stopRuntime();
					} catch (stopError) {
						terminalError ??= stopError;
					}
				}
			})();
		}, 5_000);
		while (!stopping) {
			const request = await readChatDaemonControlRequest(agentDir, kind);
			if (request?.ownerId === ownerId && request.incarnation === incarnation) {
				await clearChatDaemonControlRequest(agentDir, kind, request.requestId);
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	} finally {
		if (interval !== undefined) (deps.clearInterval ?? clearInterval)(interval);
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		try {
			await stopRuntime();
		} catch (error) {
			terminalError ??= error;
		} finally {
			if (incarnation !== undefined) {
				try {
					await releaseChatDaemonOwnership({
						agentDir,
						kind,
						ownerId,
						pid: daemonPid,
						incarnation,
						pidAlive: deps.pidAlive,
						pidIncarnation: deps.pidIncarnation,
					});
				} catch (error) {
					terminalError ??= error;
				}
			}
		}
	}
	if (terminalError !== undefined) throw terminalError;
}
