import * as crypto from "node:crypto";
import * as path from "node:path";
import {
	type ChatDaemonCommandBindInput,
	type ChatDaemonCommandOutcome,
	serveChatDaemonCommandsOnce,
} from "./chat-daemon-command-channel";
import {
	acquireChatDaemonOwnership,
	type ChatDaemonKind,
	chatDaemonGeneration,
	clearChatDaemonControlRequest,
	hasSafeChatDaemonStateShape,
	readChatDaemonControlRequest,
	readChatDaemonState,
	releaseChatDaemonOwnership,
	renewChatDaemonHeartbeat,
} from "./chat-daemon-control";
import { type ChatDaemonRuntimeConfig, ChatDaemonRuntime as DefaultChatDaemonRuntime } from "./chat-daemon-runtime";
import {
	isDiscordComplete,
	isSlackComplete,
	loadNotificationConfigFile,
	notificationConfigFromFile,
	resolveNotificationProvider,
} from "./config";

export interface ChatDaemonRuntimeHandle {
	start(): Promise<void>;
	stop(): Promise<void>;
	transportHealthy?(): boolean;
	/** Executes operator commands that must run inside the owning daemon. */
	bindExistingRoot?(request: ChatDaemonCommandBindInput): Promise<ChatDaemonCommandOutcome>;
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
		const resolution = resolveNotificationProvider(config, "discord");
		if (!resolution.desiredEnabled) return undefined;
		if (resolution.quarantined) throw new Error("Discord notification configuration needs repair");
		if (!resolution.configured || !isDiscordComplete(config)) {
			throw new Error("Discord notifications are enabled but configuration is incomplete");
		}
		const discord = config.discord;
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
	const resolution = resolveNotificationProvider(config, "slack");
	if (!resolution.desiredEnabled) return undefined;
	if (resolution.quarantined) throw new Error("Slack notification configuration needs repair");
	if (!resolution.configured || !isSlackComplete(config)) {
		throw new Error("Slack notifications are enabled but configuration is incomplete");
	}
	const slack = config.slack;
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
	let interval: NodeJS.Timeout | number | undefined;
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
		const ownedIncarnation = incarnation;
		const stillOwner = async (): Promise<boolean> => {
			const current = await readChatDaemonState(agentDir, kind);
			return (
				hasSafeChatDaemonStateShape(current) &&
				current.kind === kind &&
				current.ownerId === ownerId &&
				current.pid === daemonPid &&
				current.incarnation === ownedIncarnation &&
				current.generation === chatDaemonGeneration(kind) &&
				current.stoppedAt === undefined
			);
		};
		const bindExistingRoot = activeRuntime.bindExistingRoot?.bind(activeRuntime);
		while (!stopping) {
			const request = await readChatDaemonControlRequest(agentDir, kind);
			if (request?.ownerId === ownerId && request.incarnation === incarnation) {
				await clearChatDaemonControlRequest(agentDir, kind, request.requestId);
				break;
			}
			// Operator commands are served in place: unlike a lifecycle request they
			// must never end this loop. A serving failure degrades to the caller's
			// timeout rather than terminating a healthy transport.
			if (bindExistingRoot) {
				try {
					await serveChatDaemonCommandsOnce({
						agentDir,
						kind,
						ownerId,
						pid: daemonPid,
						incarnation: ownedIncarnation,
						generation: chatDaemonGeneration(kind),
						handler: { bindExistingRoot },
						verifyOwnership: stillOwner,
					});
				} catch {
					// Retried on the next poll; the submitter observes a timeout.
				}
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
