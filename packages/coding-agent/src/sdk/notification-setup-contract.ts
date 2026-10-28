import type { CasReceipt } from "../config/atomic-yaml-patch";
import type { NotificationProvider, ProviderSecretDisposition } from "./bus/config";
import type {
	BlockedTelegramRestoreResult,
	ProposedTelegramIdentity,
	TelegramDaemonReconnectOutcome,
} from "./bus/notification-orchestration";
import type {
	NotificationHealthReport,
	NotificationRecoveryReport,
	NotificationStatusReport,
	NotificationTestResult,
} from "./bus/notification-service";
import type { NotificationSessionReconcileResult, NotificationSessionStatus } from "./bus/session-control";

/** One-way credential input; implementations must release the value when consumed. */
export interface NotificationSetupSecretValue {
	consume(): string;
}

/** Safe scalar notification preferences. Credentials and destination IDs are deliberately absent. */
export interface NotificationsEditorPreferences {
	redact: boolean;
	verbosity: "lean" | "verbose";
	sessionScope: "all" | "primary";
	richEnabled: boolean;
	richDraftEnabled: boolean;
	toolActivityEnabled: boolean;
	streamingEnabled: boolean;
	sound: "all" | "important" | "none";
}

/** Secret-safe snapshot used to render the Notifications tab. */
export interface NotificationsEditorState {
	status: NotificationStatusReport;
	session: NotificationSessionStatus;
	preferences: NotificationsEditorPreferences;
	health?: NotificationHealthReport;
}

/**
 * A one-way setup value accepted from the masked input. The operation adapter
 * consumes the secret and returns a safe-to-render prepared draft.
 */
export interface NotificationsEditorSetupInput {
	token: NotificationSetupSecretValue;
	/** Optional: omit to use daemon-aware private-chat discovery when polling is safe. */
	chatId?: string;
	richEnabled: boolean;
	richDraftEnabled: boolean;
	streamingEnabled: boolean;
}

/**
 * Secret-safe setup draft. The adapter may retain its private credential while
 * this object is live, but no raw token is exposed through this contract.
 */
export interface PreparedTelegramConfiguration {
	chatId: string;
	tokenMask: string;
	tokenFingerprint?: string;
	richEnabled: boolean;
	richDraftEnabled: boolean;
	streamingEnabled: boolean;
}

export interface ProviderSecretActionInput {
	action: ProviderSecretDisposition;
	value?: NotificationSetupSecretValue;
}

export interface NotificationsProviderSetupInput {
	provider: "discord" | "slack";
	botToken: ProviderSecretActionInput;
	appToken?: ProviderSecretActionInput;
	applicationId?: string;
	guildId?: string;
	parentChannelId?: string;
	workspaceId?: string;
	channelId?: string;
	authorizedUserId?: string;
}

export interface PreparedNotificationProviderConfiguration {
	provider: "discord" | "slack";
	botTokenDisposition: ProviderSecretDisposition;
	botTokenMask: string;
	appTokenDisposition?: ProviderSecretDisposition;
	appTokenMask?: string;
	applicationId?: string;
	guildId?: string;
	parentChannelId?: string;
	workspaceId?: string;
	channelId?: string;
	authorizedUserId?: string;
	applicationIdDisplay?: string;
	guildIdDisplay?: string;
	parentChannelIdDisplay?: string;
	workspaceIdDisplay?: string;
	channelIdDisplay?: string;
	authorizedUserIdDisplay?: string;
}

export interface NotificationsPreflightResult {
	status: "ready" | "aborted" | "cancelled" | "error";
	identity: ProposedTelegramIdentity;
	message: string;
	pairingSource?: "discovered" | "provided" | "reused";
	draft?: PreparedTelegramConfiguration;
}

/** A successful configuration save always carries an opaque CAS receipt. */
export type NotificationsConfigureCommitResult =
	| { status: "saved"; receipt: CasReceipt; message: string }
	| { status: "activation_failed" | "observer_failed"; receipt: CasReceipt; message: string }
	| {
			status: "blocked_identity";
			receipt: CasReceipt;
			message: string;
			restore(): Promise<BlockedTelegramRestoreResult>;
			retainCommitted(): void;
	  };

export interface NotificationsMutationResult {
	message: string;
	receipt?: CasReceipt;
	outcome?: "success" | "degraded" | "failed";
	/** No persistence or activation occurred because prepared-draft authority was absent. */
	code?: "invalid_draft";
}

export type NotificationsSaveInactiveResult =
	| { status: "saved_inactive"; receipt: CasReceipt; message: string }
	| { status: "observer_failed" | "reconciliation_failed"; receipt: CasReceipt; message: string }
	| { status: "unavailable"; guidance: string };

/**
 * UI-neutral notification setup operations shared by local SDK callers and the TUI.
 * Credentials are consumed locally; prepared drafts carry no raw secrets.
 */
export interface NotificationsEditorOperations {
	/** Combines a buildNotificationStatusReport-shaped status snapshot with the current session-control query. */
	loadState(): Promise<NotificationsEditorState>;
	/** Performs offline or selected REST-only health refresh. */
	refreshHealth(input: {
		probe: boolean;
		provider?: NotificationProvider;
		signal?: AbortSignal;
	}): Promise<NotificationHealthReport>;
	sendTest(provider?: NotificationProvider): Promise<NotificationTestResult>;
	recover(): Promise<NotificationRecoveryReport>;
	reconnect(): Promise<TelegramDaemonReconnectOutcome>;
	/** Validates/discovers a Telegram destination and returns a secret-safe prepared draft. */
	preflightProposedIdentity(
		input: NotificationsEditorSetupInput,
		signal: AbortSignal,
	): Promise<NotificationsPreflightResult>;
	/** Atomically persists a prepared Telegram configuration and returns its CAS-backed receipt. */
	commitConfigure(draft: PreparedTelegramConfiguration): Promise<NotificationsConfigureCommitResult>;
	/** Stores a prepared Telegram configuration inactive when the mixed-adapter rule permits it. */
	saveInactive(draft: PreparedTelegramConfiguration): Promise<NotificationsSaveInactiveResult>;
	/** Clears adapter-local ephemeral credential material for a prepared setup draft. Idempotent. */
	discardConfigureDraft(draft: PreparedTelegramConfiguration): void;
	prepareProviderConfiguration(
		input: NotificationsProviderSetupInput,
	): Promise<PreparedNotificationProviderConfiguration>;
	commitProviderConfiguration(draft: PreparedNotificationProviderConfiguration): Promise<NotificationsMutationResult>;
	discardProviderConfiguration(draft: PreparedNotificationProviderConfiguration): void;
	setProviderDesired(provider: NotificationProvider, enabled: boolean): Promise<NotificationsMutationResult>;
	removeProvider(provider: NotificationProvider): Promise<NotificationsMutationResult>;
	/** Enables globally without requesting or exposing a credential. */
	enableGlobally(): Promise<NotificationsMutationResult>;
	disableGlobally(): Promise<NotificationsMutationResult>;
	/** Removes only Telegram configuration; the adapter preserves Discord/Slack when configured. */
	removeTelegram(): Promise<NotificationsMutationResult & { globallyDisabled?: boolean }>;
	setSessionLocal(enabled: boolean): Promise<NotificationSessionReconcileResult>;
	/** Atomically persists the scalar preference draft. */
	commitPreferences(preferences: NotificationsEditorPreferences): Promise<NotificationsMutationResult>;
	/** Reconciles the current session after durable global configuration changes. */
	reconcileCurrentSession(): Promise<NotificationSessionReconcileResult>;
}
