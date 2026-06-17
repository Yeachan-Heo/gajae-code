/**
 * Service wiring: connect the Telegram transport to the gateway and the
 * coordinator client, and run the receive loop until stopped.
 */
import type { ServiceConfig } from "./config";
import { McpStdioCoordinatorClient } from "./coordinator-client";
import { TelegramRemoteGateway } from "./gateway";
import { TelegramRemoteNotifier } from "./notifier";
import { RpcAttachmentStore } from "./rpc-attachment-store";
import { RpcBackend } from "./rpc-backend";
import { TelegramRpcGateway } from "./rpc-gateway";
import { SubscriptionStore } from "./subscriptions";
import { RPC_BOT_COMMANDS, TelegramBotApiTransport } from "./telegram";
import type { CoordinatorClient, RpcBackendPort, TelegramTransport } from "./types";

/** Optional injection points for local runs and integration tests. */
export interface RunServiceOptions {
	coordinator?: CoordinatorClient;
	rpcBackend?: RpcBackendPort;
	transport?: TelegramTransport;
}

/** Wire and run the gateway service until the transport loop ends. */
export async function runService(config: ServiceConfig, options: RunServiceOptions = {}): Promise<void> {
	const transport =
		options.transport ??
		new TelegramBotApiTransport({
			botToken: config.botToken,
			apiBase: config.apiBase,
			pollTimeoutSec: config.pollTimeoutSec,
			enableEditMessageText: config.enableEditMessageText,
			registerBotCommands: config.registerBotCommands,
			botCommands: config.backend === "rpc" ? RPC_BOT_COMMANDS : undefined,
		});
	if (config.backend === "rpc") {
		if (!config.rpc) throw new Error("telegram_remote_rpc_config_missing");
		const attachments = await RpcAttachmentStore.open({ stateDir: config.rpc.stateDir });
		const rpcBackend = options.rpcBackend ?? new RpcBackend(config.rpc);
		const gateway = new TelegramRpcGateway(
			{
				allowedUserIds: config.policy.allowedUserIds,
				allowedChatIds: config.policy.allowedChatIds,
				defaultSocketPath: config.rpc.socketPath,
				allowAttachSocketArg: config.rpc.allowAttachSocketArg,
			},
			{
				backend: rpcBackend,
				attachments,
				outbound: typeof transport.send === "function" ? transport : undefined,
				livenessMs: config.rpc.livenessMs,
			},
		);
		await gateway.restorePersistedAttachment();
		const shutdown = (): void => {
			transport.stop();
			void rpcBackend.close();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		try {
			await transport.run(update => gateway.handleUpdate(update));
		} finally {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
			await rpcBackend.close();
		}
		return;
	}

	const coordinator = options.coordinator ?? new McpStdioCoordinatorClient(config.coordinator);
	const shouldEnablePush = config.enablePush && config.stateDir !== undefined && typeof transport.send === "function";
	const subscriptions = shouldEnablePush
		? await SubscriptionStore.open({
				stateDir: config.stateDir!,
				followTtlMs: config.followTtlMs,
				maxSubscriptions: config.subscriptionsMax,
			})
		: undefined;
	const gateway = new TelegramRemoteGateway(
		{ ...config.policy, enablePush: shouldEnablePush },
		{ coordinator, subscriptions },
	);
	const notifier =
		shouldEnablePush && subscriptions && transport.send
			? new TelegramRemoteNotifier({
					coordinator,
					outbound: { send: transport.send.bind(transport) },
					subscriptions,
					renderCard: (rawSessionId, view, sub) =>
						gateway.renderNotificationCard(rawSessionId, view, { chatId: sub.chatId, userId: sub.userId }),
					longPollMs: config.longPollMs,
					digestThreshold: config.digestThreshold,
				})
			: undefined;

	const shutdown = (): void => {
		notifier?.stop();
		transport.stop();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	const notifierRun = notifier?.start();
	try {
		await transport.run(update => gateway.handleUpdate(update));
	} finally {
		notifier?.stop();
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		await notifierRun?.catch(() => undefined);
		await coordinator.close?.();
	}
}
