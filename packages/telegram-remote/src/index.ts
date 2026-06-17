/**
 * Public surface of `@gajae-code/telegram-remote`. The Telegram operator gateway
 * over the Coordinator MCP: lifecycle and observation only, with optional rich
 * messaging (inline keyboards, HTML formatting, callback queries).
 */
export { parseCommand } from "./commands";
export { loadConfigFromEnv, type ServiceConfig } from "./config";
export { McpStdioCoordinatorClient, type McpStdioOptions } from "./coordinator-client";
export { type GatewayDeps, type GatewayPolicy, TelegramRemoteGateway } from "./gateway";
export { MESSAGES, UNAUTHORIZED_REFUSAL } from "./messages";
export { type NotifierDeps, TelegramRemoteNotifier } from "./notifier";
export { assertValidPreset, type PresetResolution, resolvePreset, sanitizeTask, TASK_SLOT } from "./presets";
export {
	activeTurnId,
	deriveStatus,
	deriveTurnActivity,
	escapeHtml,
	findSessionView,
	formatRelativeTime,
	isTerminalStatus,
	isWithinRetention,
	projectSessionRows,
	projectSessionSummaries,
	projectSessionSummary,
	projectSessionView,
	RETENTION_DEFAULT_MS,
	readSessionId,
	renderSessionsList,
	renderSessionsListHtml,
	renderSessionView,
	renderSessionViewHtml,
	shortSessionId,
} from "./projection";
export { RPC_ATTACHMENT_FILE_NAME, RpcAttachmentStore } from "./rpc-attachment-store";
export { FakeRpcBackend, RpcBackend } from "./rpc-backend";
export { type RpcGatewayDeps, type RpcGatewayPolicy, TelegramRpcGateway } from "./rpc-gateway";
export { type RunServiceOptions, runService } from "./service";
export {
	resolveStateDir,
	STATE_FILE_NAME,
	type Subscription,
	SubscriptionStore,
	type SubscriptionStoreOptions,
	type SubscriptionStoreState,
} from "./subscriptions";
export { type TelegramBotApiOptions, TelegramBotApiTransport } from "./telegram";
export {
	CALLBACK_PREFIX,
	type CallbackAction,
	type CallbackTokenRecord,
	CallbackTokenStore,
	parseCallbackData,
} from "./tokens";
export type {
	AttachmentRecord,
	CallbackAnswer,
	CallbackAnswerOnlyReply,
	ChatReply,
	CoordinationStatus,
	CoordinatorClient,
	GatewayPreset,
	IncomingCallbackQuery,
	IncomingMessage,
	IncomingTextMessage,
	IncomingUpdate,
	OutgoingReply,
	ParsedCommand,
	RawRecord,
	ReportStatusResult,
	RpcBackendConfig,
	RpcBackendPort,
	RpcBackendState,
	SessionStatus,
	SessionSummary,
	SessionView,
	StartSessionResult,
	TelegramInlineKeyboardButton,
	TelegramInlineKeyboardMarkup,
	TelegramParseMode,
	TelegramTransport,
	TurnActivity,
} from "./types";
