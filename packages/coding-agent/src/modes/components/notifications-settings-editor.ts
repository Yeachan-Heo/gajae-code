import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	SecretInput,
	type SecretValue,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@gajae-code/tui";
import type { CasReceipt } from "../../config/atomic-yaml-patch";
import type {
	BlockedTelegramRestoreResult,
	ProposedTelegramIdentity,
	TelegramDaemonReconnectOutcome,
} from "../../sdk/bus/notification-orchestration";
import type {
	NotificationHealthReport,
	NotificationRecoveryReport,
	NotificationStatusReport,
	NotificationTestResult,
} from "../../sdk/bus/notification-service";
import type { NotificationSessionReconcileResult, NotificationSessionStatus } from "../../sdk/bus/session-control";
import { theme } from "../theme/theme";

/** Safe scalar notification preferences. Credentials and destination IDs are deliberately absent. */
export interface NotificationsEditorPreferences {
	redact: boolean;
	verbosity: "lean" | "verbose";
	sessionScope: "all" | "primary";
	richEnabled: boolean;
	richDraftEnabled: boolean;
	toolActivityEnabled: boolean;
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
	token: SecretValue;
	/** Optional: omit to use daemon-aware private-chat discovery when polling is safe. */
	chatId?: string;
	richEnabled: boolean;
	richDraftEnabled: boolean;
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
}

export type NotificationsSaveInactiveResult =
	| { status: "saved_inactive"; receipt: CasReceipt; message: string }
	| { status: "unavailable"; guidance: string };

/**
 * Controller-injected boundary for the direct Notifications editor.
 *
 * The component only renders this contract and sends user intent through it:
 * it never reads Settings, starts a daemon, or calls notification services.
 */
export interface NotificationsEditorOperations {
	/** Combines a buildNotificationStatusReport-shaped status snapshot with the current session-control query. */
	loadState(): Promise<NotificationsEditorState>;
	/** Performs offline health refreshes and a non-cancellable reachability probe when requested. */
	refreshHealth(input: { probe: boolean; signal?: AbortSignal }): Promise<NotificationHealthReport>;
	sendTest(): Promise<NotificationTestResult>;
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

export interface NotificationsSettingsEditorCallbacks {
	onCancel?: () => void;
}

type EditorMode =
	| "home"
	| "provider-selection"
	| "chat-entry"
	| "token-entry"
	| "pairing"
	| "review"
	| "preferences"
	| "confirmation";
type ConfirmationAction = "disable" | "remove" | "blocked_identity";

type HomeActionId =
	| "configure"
	| "enable"
	| "disable"
	| "session"
	| "refresh"
	| "probe"
	| "test"
	| "recover"
	| "reconnect"
	| "remove"
	| "preferences"
	| "tool-activity";

interface Action {
	id: HomeActionId | "telegram" | "external" | "save" | "save-inactive" | "cancel" | "confirm";
	label: string;
	description: string;
}

const TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{20,}/g;
const VISIBLE_ACTIONS = 5;

function emptyState(): NotificationsEditorState {
	return {
		status: {
			enabled: false,
			redact: false,
			verbosity: "lean",
			globallyConfigured: false,
			telegram: { botTokenMasked: "(not set)", channel: undefined, configured: false, tokenFingerprint: undefined },
			discord: { botTokenMasked: "(not set)", channel: undefined, configured: false },
			slack: { botTokenMasked: "(not set)", channel: undefined, configured: false },
		},
		session: {
			eligible: false,
			locallyEnabled: false,
			effectiveEnabled: false,
			running: false,
			environment: "default",
		},
		preferences: {
			redact: false,
			verbosity: "lean",
			sessionScope: "all",
			richEnabled: true,
			richDraftEnabled: false,
			toolActivityEnabled: true,
		},
	};
}

function statusLabel(level: "ok" | "warn" | "error"): "OK" | "WARNING" | "ERROR" {
	return level === "ok" ? "OK" : level === "warn" ? "WARNING" : "ERROR";
}

function safeDetail(value: string | undefined, fallback: string): string {
	const detail = (value ?? fallback)
		.replace(TOKEN_PATTERN, "<redacted>")
		.replace(/[\r\n]+/g, " ")
		.trim();
	return detail || fallback;
}

function formatAge(ageMs: number | undefined): string {
	if (ageMs === undefined || !Number.isFinite(ageMs) || ageMs < 0) return "unknown";
	if (ageMs < 1_000) return "just now";
	if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
	if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
	return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

function formatTimestamp(timestamp: number | undefined): string {
	if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp < 0) return "unknown";
	return new Date(timestamp).toISOString();
}

function maskedToken(value: string | undefined, fallback: string): string {
	if (!value) return fallback;
	const maskLength = [...value].filter(character => character === "•" || character === "*").length;
	return "•".repeat(Math.max(4, maskLength));
}

function copyPreferences(preferences: NotificationsEditorPreferences): NotificationsEditorPreferences {
	return { ...preferences };
}

/**
 * Direct tab content for notification setup and operations. It is deliberately
 * independent of Settings and notification services; WI7b injects the adapter.
 */
export class NotificationsSettingsEditorComponent implements Component, Focusable {
	focused = false;
	#state = emptyState();
	#mode: EditorMode = "home";
	#selectedIndex = 0;
	#status = "INFO — Loading notification status…";
	#lastTest: NotificationTestResult | undefined;
	#prepared: PreparedTelegramConfiguration | undefined;
	#preflightIdentity: ProposedTelegramIdentity["status"] | undefined;
	#preferencesDraft: NotificationsEditorPreferences | undefined;
	#confirmation: ConfirmationAction | undefined;
	#blockedCommit: Extract<NotificationsConfigureCommitResult, { status: "blocked_identity" }> | undefined;
	#pairingPhase: "discovery" | "validation" = "discovery";
	#chatInput = new Input();
	#tokenInput = new SecretInput();
	#abortController = new AbortController();
	#cancellableWork: Promise<void> | undefined;
	#guarded = false;
	#disposed = false;
	#loadSequence = 0;

	constructor(
		private readonly operations: NotificationsEditorOperations,
		private readonly callbacks: NotificationsSettingsEditorCallbacks = {},
	) {
		this.#chatInput.onSubmit = () => {
			this.#mode = "token-entry";
			this.#status = "INFO — Paste the Telegram bot token. It is masked and never shown again.";
		};
		this.#chatInput.onEscape = () => this.#cancelCurrentMode();
		this.#tokenInput.onSubmit = token => this.#startPreflight(token);
		this.#tokenInput.onEscape = () => this.#cancelCurrentMode();
		void this.#loadState();
	}

	/** True while a guarded operation or blocked restore/retain decision owns the editor. */
	get navigationLocked(): boolean {
		return this.#guarded || this.#blockedCommit !== undefined;
	}

	/** Current state is exposed for selector lifecycle coordination and focused tests. */
	get mode(): EditorMode {
		return this.#mode;
	}

	invalidate(): void {
		this.#chatInput.invalidate();
		this.#tokenInput.invalidate();
	}

	dispose(): void {
		if (this.#disposed || this.navigationLocked) return;
		this.#disposed = true;
		this.#abortController.abort();
		this.#clearDrafts(true);
	}

	render(width: number): string[] {
		if (this.#mode === "provider-selection") return this.#renderProviderSelection(width);
		if (this.#mode === "chat-entry") return this.#renderChatEntry(width);
		if (this.#mode === "token-entry") return this.#renderTokenEntry(width);
		if (this.#mode === "pairing") return this.#renderPairing(width);
		if (this.#mode === "review") return this.#renderReview(width);
		if (this.#mode === "preferences") return this.#renderPreferences(width);
		if (this.#mode === "confirmation") return this.#renderConfirmation(width);
		return this.#renderHome(width);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (this.#guarded) {
			this.#status =
				"WARNING — Request in progress; it may already have been delivered or started. Navigation is locked.";
			return;
		}
		if (this.#cancellableWork) {
			if (this.#matchesCancel(data)) {
				this.#cancelCancellableWork(
					"Cancellable notification operation cancelled; saved configuration is unchanged.",
				);
			} else {
				this.#status = "PENDING — Cancellable notification operation in progress. Press Esc to cancel it.";
			}
			return;
		}
		if (this.#mode === "chat-entry") {
			this.#chatInput.handleInput(data);
			return;
		}
		if (this.#mode === "token-entry") {
			this.#tokenInput.handleInput(data);
			return;
		}
		if (this.#mode === "pairing") {
			if (this.#matchesCancel(data))
				this.#cancelCancellableWork("Pairing cancelled; no notification configuration was changed.");
			return;
		}
		if (this.#mode === "provider-selection") {
			this.#handleListInput(data, this.#providerActions());
			return;
		}
		if (this.#mode === "review") {
			this.#handleListInput(data, this.#reviewActions());
			return;
		}
		if (this.#mode === "preferences") {
			this.#handlePreferencesInput(data);
			return;
		}
		if (this.#mode === "confirmation") {
			this.#handleConfirmationInput(data);
			return;
		}
		this.#handleListInput(data, this.#homeActions());
	}

	#matchesCancel(data: string): boolean {
		return getKeybindings().matches(data, "tui.select.cancel");
	}

	#handleListInput(data: string, actions: readonly Action[]): void {
		if (this.#matchesCancel(data)) {
			this.#cancelCurrentMode();
			return;
		}
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? actions.length - 1 : this.#selectedIndex - 1;
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.#selectedIndex = this.#selectedIndex === actions.length - 1 ? 0 : this.#selectedIndex + 1;
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || data === " " || data === "\n") {
			const action = actions[this.#selectedIndex];
			if (action) this.#activate(action.id);
		}
	}

	#handlePreferencesInput(data: string): void {
		const actions = this.#preferenceActions();
		if (this.#matchesCancel(data)) {
			this.#preferencesDraft = undefined;
			this.#mode = "home";
			this.#selectedIndex = 0;
			this.#status = "INFO — Preference changes discarded.";
			return;
		}
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? actions.length - 1 : this.#selectedIndex - 1;
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.#selectedIndex = this.#selectedIndex === actions.length - 1 ? 0 : this.#selectedIndex + 1;
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || data === " " || data === "\n") {
			const action = actions[this.#selectedIndex];
			if (!action) return;
			if (action.id === "save") {
				this.#savePreferences();
				return;
			}
			if (action.id === "cancel") {
				this.#preferencesDraft = undefined;
				this.#mode = "home";
				this.#selectedIndex = 0;
				this.#status = "INFO — Preference changes discarded.";
				return;
			}
			this.#togglePreference(action.id);
		}
	}

	#handleConfirmationInput(data: string): void {
		const blocked = this.#confirmation === "blocked_identity";
		if (this.#matchesCancel(data)) {
			if (blocked) this.#retainBlockedConfiguration();
			else {
				this.#confirmation = undefined;
				this.#mode = "home";
				this.#selectedIndex = 0;
				this.#status = "INFO — Confirmation cancelled; configuration is unchanged.";
			}
			return;
		}
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? 1 : 0;
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || data === " " || data === "\n") {
			if (blocked) {
				if (this.#selectedIndex === 0) this.#restoreBlockedConfiguration();
				else this.#retainBlockedConfiguration();
				return;
			}
			if (this.#selectedIndex === 0) this.#confirmDestructiveAction();
			else {
				this.#confirmation = undefined;
				this.#mode = "home";
				this.#selectedIndex = 0;
				this.#status = "INFO — Confirmation cancelled; configuration is unchanged.";
			}
		}
	}

	#activate(id: Action["id"]): void {
		switch (id) {
			case "configure":
				this.#mode = "provider-selection";
				this.#selectedIndex = 0;
				this.#status = "INFO — Select a notification provider to begin setup.";
				return;
			case "telegram":
				this.#mode = "chat-entry";
				this.#selectedIndex = 0;
				this.#chatInput.setValue("");
				this.#tokenInput.clear();
				this.#status = "INFO — Enter a private chat ID, or leave it blank for guided pairing discovery.";
				return;
			case "external":
				this.#status = "INFO — Discord and Slack credentials are managed in their respective provider settings.";
				return;
			case "enable":
				this.#enableGlobally();
				return;
			case "disable":
				this.#openConfirmation("disable");
				return;
			case "session":
				this.#setSessionLocal(!this.#state.session.locallyEnabled);
				return;
			case "refresh":
				this.#refreshHealth(false);
				return;
			case "probe":
				this.#refreshHealth(true);
				return;
			case "test":
				this.#sendTest();
				return;
			case "recover":
				this.#recover();
				return;
			case "reconnect":
				this.#reconnect();
				return;
			case "remove":
				this.#openConfirmation("remove");
				return;
			case "preferences":
				this.#preferencesDraft = copyPreferences(this.#state.preferences);
				this.#selectedIndex = 0;
				this.#mode = "preferences";
				this.#status = "INFO — Edit the draft, then explicitly save it atomically.";
				return;
			case "save":
				this.#commitConfiguration();
				return;
			case "save-inactive":
				this.#saveInactive();
				return;
			case "cancel":
				this.#cancelCurrentMode();
				return;
			default:
				return;
		}
	}

	#cancelCurrentMode(): void {
		if (this.#mode === "home") {
			this.callbacks.onCancel?.();
			return;
		}
		if (this.#mode === "pairing") {
			this.#cancelCancellableWork("Pairing cancelled; no notification configuration was changed.");
			return;
		}
		this.#clearDrafts();
		this.#mode = "home";
		this.#selectedIndex = 0;
		this.#status = "INFO — Setup cancelled; saved notification configuration is unchanged.";
	}

	#clearDrafts(disposeSecret = false): void {
		if (this.#prepared) this.operations.discardConfigureDraft(this.#prepared);
		this.#prepared = undefined;
		this.#preflightIdentity = undefined;
		this.#pairingPhase = "discovery";
		this.#preferencesDraft = undefined;
		this.#chatInput.setValue("");
		this.#tokenInput.clear();
		if (disposeSecret) this.#tokenInput.dispose();
	}

	#startPreflight(token: SecretValue): void {
		const chatId = this.#chatInput.getValue().trim() || undefined;
		const preferences = this.#state.preferences;
		this.#pairingPhase = chatId ? "validation" : "discovery";
		this.#mode = "pairing";
		this.#status = chatId
			? "PENDING — Private-chat validation in progress. Escape cancels before configuration changes."
			: "PENDING — Pairing discovery in progress. Escape cancels before configuration changes.";
		this.#runCancellable(
			signal =>
				this.operations.preflightProposedIdentity(
					{
						token,
						chatId,
						richEnabled: preferences.richEnabled,
						richDraftEnabled: preferences.richDraftEnabled,
					},
					signal,
				),
			result => {
				this.#tokenInput.clear();
				if (result.status === "aborted" || result.status === "cancelled") {
					this.#clearDrafts();
					this.#mode = "home";
					this.#selectedIndex = 0;
					this.#status = "ABORTED — Pairing cancelled; saved notification configuration is unchanged.";
					return;
				}
				if (result.status !== "ready" || !result.draft) {
					this.#clearDrafts();
					this.#mode = "home";
					this.#selectedIndex = 0;
					this.#status = `ERROR — ${safeDetail(result.message, "Telegram setup could not be completed.")}`;
					return;
				}
				this.#prepared = result.draft;
				this.#preflightIdentity = result.identity.status;
				this.#mode = "review";
				this.#selectedIndex = 0;
				const identity = result.identity.status;
				this.#status =
					identity === "foreign" || identity === "unknown"
						? `WARNING — ${safeDetail(result.message, "A foreign or unknown Telegram daemon identity blocks activation.")}`
						: `OK — ${safeDetail(result.message, "Telegram setup is ready to save.")}`;
			},
		);
	}

	#cancelCancellableWork(message: string): void {
		this.#abortController.abort();
		this.#clearDrafts();
		this.#mode = "home";
		this.#selectedIndex = 0;
		this.#status = `ABORTED — ${message}`;
	}

	#runCancellable<T>(work: (signal: AbortSignal) => Promise<T>, complete: (result: T) => void): void {
		if (this.#abortController.signal.aborted) this.#abortController = new AbortController();
		const controller = this.#abortController;
		let pending!: Promise<void>;
		pending = (async () => {
			try {
				const result = await work(controller.signal);
				if (this.#disposed || controller.signal.aborted || controller !== this.#abortController) return;
				complete(result);
			} catch {
				if (this.#disposed || controller.signal.aborted || controller !== this.#abortController) return;
				this.#mode = "home";
				this.#selectedIndex = 0;
				this.#status = "ERROR — Cancellable notification operation failed safely; retry when ready.";
			} finally {
				if (this.#cancellableWork === pending) this.#cancellableWork = undefined;
			}
		})();
		this.#cancellableWork = pending;
	}

	#refreshHealth(probe: boolean): void {
		if (probe) {
			this.#runGuarded(
				"Health probe in progress. It cannot be cancelled once started.",
				() => this.operations.refreshHealth({ probe: true }),
				health => {
					this.#state = { ...this.#state, health };
					this.#status = `${statusLabel(health.overall)} — ${this.#healthSummary(health)}`;
				},
			);
			return;
		}
		this.#status = "PENDING — Refreshing notification health.";
		this.#runCancellable(
			signal => this.operations.refreshHealth({ probe: false, signal }),
			health => {
				this.#state = { ...this.#state, health };
				this.#status = `${statusLabel(health.overall)} — ${this.#healthSummary(health)}`;
			},
		);
	}

	#runGuarded<T>(pending: string, work: () => Promise<T>, complete: (result: T) => Promise<void> | void): void {
		if (this.#guarded || this.#disposed) return;
		this.#guarded = true;
		this.#status = `PENDING — ${pending} Navigation is locked; it may already have started or delivered.`;
		void (async () => {
			try {
				const result = await work();
				if (this.#disposed) return;
				await complete(result);
			} catch {
				if (!this.#disposed) {
					this.#status = "ERROR — Notification action failed safely. Retry when ready; no credential is shown.";
				}
			} finally {
				if (!this.#disposed) this.#guarded = false;
			}
		})();
	}

	async #afterDurableMutation(): Promise<boolean> {
		await this.operations.reconcileCurrentSession();
		const health = await this.operations.refreshHealth({ probe: false });
		if (this.#disposed) return false;
		this.#state = { ...this.#state, health };
		await this.#loadState();
		return !this.#disposed;
	}

	async #refreshAfterOperation(): Promise<boolean> {
		const health = await this.operations.refreshHealth({ probe: false });
		if (this.#disposed) return false;
		this.#state = { ...this.#state, health };
		await this.#loadState();
		return !this.#disposed;
	}

	#enableGlobally(): void {
		this.#runGuarded(
			"Enabling global notifications.",
			() => this.operations.enableGlobally(),
			async result => {
				if (!(await this.#afterDurableMutation())) return;

				this.#status = `OK — ${safeDetail(result.message, "Global notifications enabled using stored credentials.")}`;
			},
		);
	}

	#confirmDestructiveAction(): void {
		const action = this.#confirmation;
		this.#confirmation = undefined;
		if (action === "disable") {
			this.#runGuarded(
				"Disabling notifications globally.",
				() => this.operations.disableGlobally(),
				async result => {
					if (!(await this.#afterDurableMutation())) return;
					this.#mode = "home";
					this.#selectedIndex = 0;
					this.#status = `OK — ${safeDetail(result.message, "Notifications disabled globally.")}`;
				},
			);
			return;
		}
		if (action === "remove") {
			this.#runGuarded(
				"Removing Telegram configuration.",
				() => this.operations.removeTelegram(),
				async result => {
					if (!(await this.#afterDurableMutation())) return;
					this.#mode = "home";
					this.#selectedIndex = 0;
					this.#status = `OK — ${safeDetail(
						result.message,
						result.globallyDisabled
							? "Telegram removed and global notifications disabled."
							: "Telegram removed; other adapters remain enabled.",
					)}`;
				},
			);
		}
	}

	#restoreBlockedConfiguration(): void {
		const blocked = this.#blockedCommit;
		if (!blocked) return;
		this.#runGuarded(
			"Restoring the previous Telegram configuration.",
			() => blocked.restore(),
			async result => {
				this.#blockedCommit = undefined;
				this.#confirmation = undefined;
				if (!(await this.#refreshAfterOperation())) return;
				this.#mode = "home";
				this.#selectedIndex = 0;
				switch (result.status) {
					case "restored":
						this.#status = "OK — Previous Telegram configuration restored after the blocked activation.";
						return;
					case "conflict":
						this.#status = `ERROR — Previous configuration was not restored because settings changed at: ${result.paths.join(", ")}. Saved configuration remains inactive.`;
						return;
					case "still_blocked":
						this.#status =
							"ERROR — Previous configuration restored, but activation remains blocked by a foreign daemon. Current session remains inactive.";
						return;
					case "discarded":
						this.#status =
							"WARNING — Previous configuration was not restored. Saved configuration remains inactive.";
						return;
				}
			},
		);
	}

	#retainBlockedConfiguration(): void {
		const blocked = this.#blockedCommit;
		if (!blocked) return;
		this.#runGuarded(
			"Keeping saved Telegram configuration inactive.",
			async () => blocked.retainCommitted(),
			async () => {
				this.#blockedCommit = undefined;
				this.#confirmation = undefined;
				if (!(await this.#refreshAfterOperation())) return;
				this.#mode = "home";
				this.#selectedIndex = 0;
				this.#status =
					"WARNING — Configuration saved but activation blocked by a foreign daemon. Saved configuration remains inactive.";
			},
		);
	}

	#openConfirmation(action: Exclude<ConfirmationAction, "blocked_identity">): void {
		this.#confirmation = action;
		this.#mode = "confirmation";
		this.#selectedIndex = 1;
		this.#status =
			action === "disable"
				? "WARNING — Disable globally stops configured adapters. Confirm explicitly to continue."
				: "WARNING — Remove only Telegram credentials. Discord and Slack remain unchanged.";
	}

	#setSessionLocal(enabled: boolean): void {
		this.#runGuarded(
			enabled ? "Enabling notifications for this session." : "Disabling notifications for this session.",
			() => this.operations.setSessionLocal(enabled),
			async result => {
				if (!(await this.#refreshAfterOperation())) return;

				if (!result.status.eligible) {
					this.#status = "WARNING — Session notification controls are unavailable in this host session.";
					return;
				}
				this.#status = `OK — Session notifications ${result.status.locallyEnabled ? "enabled" : "disabled"}; runtime is ${
					result.status.running ? "active" : "inactive"
				}.`;
			},
		);
	}

	#sendTest(): void {
		this.#runGuarded(
			"Sending a notification test.",
			() => this.operations.sendTest(),
			async result => {
				this.#lastTest = result;
				if (!(await this.#refreshAfterOperation())) return;

				this.#status = `${result.ok ? "OK" : "ERROR"} — Test ${result.ok ? "delivered" : "failed"}: ${safeDetail(
					result.detail,
					"No delivery detail returned.",
				)}`;
			},
		);
	}

	#recover(): void {
		this.#runGuarded(
			"Recovering notification delivery.",
			() => this.operations.recover(),
			async result => {
				if (!(await this.#refreshAfterOperation())) return;

				this.#status = `OK — Recovery scanned ${result.endpointsScanned} endpoint(s); removed ${result.endpointsRemoved.length}. ${safeDetail(
					result.daemon.detail,
					"Daemon recovery completed.",
				)}`;
			},
		);
	}

	#reconnect(): void {
		this.#runGuarded(
			"Reconnecting the Telegram runtime.",
			() => this.operations.reconnect(),
			async result => {
				if (!(await this.#refreshAfterOperation())) return;

				this.#status =
					result === "blocked_identity"
						? "ERROR — Telegram activation is blocked by a foreign daemon. Current session is stopped; foreign daemon untouched."
						: `OK — Telegram daemon ${result}.`;
			},
		);
	}

	#commitConfiguration(): void {
		const draft = this.#prepared;
		if (!draft) {
			this.#mode = "home";
			this.#status = "ERROR — The setup draft expired. Re-enter the masked Telegram token.";
			return;
		}
		this.#runGuarded(
			"Saving Telegram configuration.",
			() => this.operations.commitConfigure(draft),
			async result => {
				this.#clearDrafts();
				if (result.status === "blocked_identity") {
					this.#blockedCommit = result;
					if (!(await this.#refreshAfterOperation())) return;
					this.#confirmation = "blocked_identity";
					this.#mode = "confirmation";
					this.#selectedIndex = 0;
					this.#status = `ERROR — ${safeDetail(
						result.message,
						"Configuration saved but activation blocked by a foreign daemon.",
					)}`;
					return;
				}
				if (!(await this.#afterDurableMutation())) return;
				this.#mode = "home";
				this.#selectedIndex = 0;
				this.#status = `OK — ${safeDetail(result.message, "Telegram configuration saved and reconciled.")}`;
			},
		);
	}

	#saveInactive(): void {
		const draft = this.#prepared;
		if (!draft) return;
		this.#runGuarded(
			"Saving Telegram configuration inactive for later.",
			() => this.operations.saveInactive(draft),
			async result => {
				if (result.status === "unavailable") {
					this.#mode = "review";
					this.#status = `WARNING — ${safeDetail(result.guidance, "Save inactive is unavailable while another adapter is globally enabled.")}`;
					return;
				}
				if (!(await this.#afterDurableMutation())) return;

				this.#clearDrafts();
				this.#mode = "home";
				this.#selectedIndex = 0;
				this.#status = `OK — ${safeDetail(result.message, "Telegram configuration saved inactive; foreign daemon untouched.")}`;
			},
		);
	}

	#savePreferences(): void {
		const preferences = this.#preferencesDraft;
		if (!preferences) return;
		this.#runGuarded(
			"Saving notification preferences.",
			() => this.operations.commitPreferences(preferences),
			async result => {
				if (!(await this.#afterDurableMutation())) return;
				this.#preferencesDraft = undefined;
				this.#mode = "home";
				this.#selectedIndex = 0;
				this.#status = `OK — ${safeDetail(result.message, "Notification preferences saved atomically.")}`;
			},
		);
	}

	#togglePreference(id: Action["id"]): void {
		const draft = this.#preferencesDraft;
		if (!draft) return;
		switch (id) {
			case "configure":
				draft.redact = !draft.redact;
				return;
			case "enable":
				draft.verbosity = draft.verbosity === "lean" ? "verbose" : "lean";
				return;
			case "disable":
				draft.sessionScope = draft.sessionScope === "all" ? "primary" : "all";
				return;
			case "session":
				draft.richEnabled = !draft.richEnabled;
				return;
			case "refresh":
				draft.richDraftEnabled = !draft.richDraftEnabled;
				return;
			case "tool-activity":
				draft.toolActivityEnabled = !draft.toolActivityEnabled;
				return;
			default:
				return;
		}
	}

	#providerActions(): readonly Action[] {
		return [
			{
				id: "telegram",
				label: "Telegram",
				description: "Configure a masked bot token and optionally validate or discover a private-chat destination.",
			},
			{
				id: "external",
				label: "Discord (managed elsewhere)",
				description:
					"Discord credentials are configured by the Discord provider integration, not this Telegram setup flow.",
			},
			{
				id: "external",
				label: "Slack (managed elsewhere)",
				description:
					"Slack credentials are configured by the Slack provider integration, not this Telegram setup flow.",
			},
		];
	}

	#homeActions(): readonly Action[] {
		return [
			{
				id: "configure",
				label: this.#state.status.telegram.configured ? "Reconfigure Telegram" : "Configure Telegram",
				description:
					"Enter a masked Telegram credential and optionally a private-chat destination; guided discovery is available.",
			},
			{
				id: "enable",
				label: "Enable globally",
				description: "Use stored complete credentials without showing a token.",
			},
			{
				id: "disable",
				label: "Disable globally",
				description: "Stops all globally configured notification adapters after confirmation.",
			},
			{
				id: "session",
				label: this.#state.session.locallyEnabled
					? "Turn session notifications off"
					: "Turn session notifications on",
				description: "Changes only the current session-local notification gate.",
			},
			{
				id: "refresh",
				label: "Refresh health",
				description: "Read the current local health and daemon ownership state.",
			},
			{
				id: "probe",
				label: "Probe health",
				description: "Optionally check Telegram reachability; once started, the probe runs to completion.",
			},
			{
				id: "test",
				label: "Send test notification",
				description: "Sends one test; it may already be delivered once started.",
			},
			{
				id: "recover",
				label: "Recover notification delivery",
				description: "Safely remove only dead-owner artifacts.",
			},
			{
				id: "reconnect",
				label: "Reconnect Telegram runtime",
				description: "Reconcile the daemon identity without disturbing a foreign owner.",
			},
			{
				id: "remove",
				label: "Remove Telegram",
				description: "Removes Telegram only; Discord and Slack remain unchanged.",
			},
			{
				id: "preferences",
				label: "Notification preferences",
				description: "Draft safe scalar preferences, then save them atomically.",
			},
		];
	}

	#reviewActions(): readonly Action[] {
		const foreignOrUnknown = this.#preflightIdentity === "foreign" || this.#preflightIdentity === "unknown";
		if (foreignOrUnknown) {
			return [
				{
					id: "save-inactive",
					label: "Save inactive for later",
					description: "Store Telegram only when no enabled Discord or Slack adapter would be disabled.",
				},
				{ id: "cancel", label: "Cancel setup", description: "Discard this transient setup draft." },
			];
		}
		return [
			{
				id: "save",
				label: "Save configuration",
				description: "Atomically save this reviewed Telegram configuration.",
			},
			{ id: "cancel", label: "Cancel setup", description: "Discard this transient setup draft." },
		];
	}

	#preferenceActions(): readonly Action[] {
		const draft = this.#preferencesDraft ?? this.#state.preferences;
		return [
			{
				id: "configure",
				label: `Redact notification content: ${draft.redact ? "on" : "off"}`,
				description: "Toggle the unsaved redaction preference.",
			},
			{
				id: "enable",
				label: `Notification verbosity: ${draft.verbosity}`,
				description: "Toggle between lean and verbose drafts.",
			},
			{
				id: "disable",
				label: `Session scope: ${draft.sessionScope}`,
				description: "Toggle between all and primary sessions.",
			},
			{
				id: "session",
				label: `Telegram rich messages: ${draft.richEnabled ? "on" : "off"}`,
				description: "Toggle the unsaved rich-message preference.",
			},
			{
				id: "refresh",
				label: `Telegram rich drafts: ${draft.richDraftEnabled ? "on" : "off"}`,
				description: "Toggle the unsaved rich-draft preference.",
			},
			{
				id: "tool-activity",
				label: `Telegram tool activity: ${draft.toolActivityEnabled ? "on" : "off"}`,
				description: "Toggle tool start and completion notifications.",
			},
			{ id: "save", label: "Save preferences", description: "Atomically persist this preference draft." },
			{ id: "cancel", label: "Cancel and discard draft", description: "Leave saved preferences unchanged." },
		];
	}

	#renderHome(width: number): string[] {
		const lines = this.#renderSummary(width);
		lines.push("");
		this.#renderActionList(lines, width, this.#homeActions());
		return lines;
	}

	#renderProviderSelection(width: number): string[] {
		const lines = [theme.bold(theme.fg("accent", "Choose a notification provider"))];
		this.#appendWrapped(
			lines,
			"Select a provider to configure. Telegram setup uses a masked token and an optional private-chat ID; Discord and Slack credentials are managed by their provider integrations.",
			width,
			"muted",
		);
		lines.push("");
		this.#renderActionList(lines, width, this.#providerActions());
		return lines;
	}

	#renderChatEntry(width: number): string[] {
		const lines = [theme.bold(theme.fg("accent", "Telegram setup — private chat ID (optional)"))];
		this.#appendWrapped(
			lines,
			"Enter a Telegram private chat ID to validate it, or leave this blank for guided private-chat discovery when polling is safe. A live same-token daemon reuses and validates its stored chat without polling.",
			width,
			"muted",
		);
		lines.push("");
		this.#chatInput.focused = this.focused;
		for (const line of this.#chatInput.render(width)) lines.push(line);
		lines.push("");
		this.#appendStatus(lines, width);
		lines.push(theme.fg("dim", "  Enter to continue · Esc to cancel setup"));
		return lines;
	}

	#renderTokenEntry(width: number): string[] {
		const lines = [theme.bold(theme.fg("accent", "Telegram setup — masked bot token"))];
		this.#appendWrapped(
			lines,
			"Paste the bot token. Only bullets render; the saved token is never prefilled or displayed.",
			width,
			"muted",
		);
		lines.push("");
		this.#tokenInput.focused = this.focused;
		for (const line of this.#tokenInput.render(width)) lines.push(line);
		lines.push("");
		this.#appendStatus(lines, width);
		lines.push(theme.fg("dim", "  Enter to validate · Esc to discard setup"));
		return lines;
	}

	#renderPairing(width: number): string[] {
		const validating = this.#pairingPhase === "validation";
		const lines = [
			theme.bold(
				theme.fg(
					"accent",
					validating ? "Telegram setup — private-chat validation" : "Telegram setup — pairing discovery",
				),
			),
		];
		this.#appendWrapped(
			lines,
			validating
				? "Validating the supplied private-chat destination. This is cancellable and has not changed configuration."
				: "Discovering a private chat when polling is safe. A live same-token daemon reuses and validates its stored chat without polling. This is cancellable and has not changed configuration.",
			width,
			"muted",
		);
		lines.push("");
		this.#appendStatus(lines, width);
		lines.push(theme.fg("dim", "  Esc to cancel pairing · No configuration is saved until review confirms it"));
		return lines;
	}

	#renderReview(width: number): string[] {
		const draft = this.#prepared;
		const lines = [theme.bold(theme.fg("accent", "Review Telegram notification setup"))];
		lines.push(
			this.#truncate(
				`  Token: ${maskedToken(draft?.tokenMask, "(expired)")}  fingerprint: ${draft?.tokenFingerprint ?? "(not available)"}`,
				width,
			),
		);
		lines.push(
			this.#truncate(
				`  Private chat: ${draft?.chatId ?? "(expired)"}  rich: ${draft?.richEnabled ? "on" : "off"}  drafts: ${draft?.richDraftEnabled ? "on" : "off"}`,
				width,
			),
		);
		lines.push("");
		this.#renderActionList(lines, width, this.#reviewActions());
		return lines;
	}

	#renderPreferences(width: number): string[] {
		const lines = [theme.bold(theme.fg("accent", "Notification preferences — unsaved draft"))];
		this.#appendWrapped(
			lines,
			"These safe scalar changes do not affect settings until Save preferences completes atomically.",
			width,
			"muted",
		);
		lines.push("");
		this.#renderActionList(lines, width, this.#preferenceActions());
		return lines;
	}

	#renderConfirmation(width: number): string[] {
		const blocked = this.#confirmation === "blocked_identity";
		const removing = this.#confirmation === "remove";
		const lines = [
			theme.bold(
				theme.fg(
					"accent",
					blocked
						? "Telegram activation blocked by foreign daemon"
						: removing
							? "Remove Telegram configuration?"
							: "Disable notifications globally?",
				),
			),
		];
		this.#appendWrapped(
			lines,
			blocked
				? "Configuration saved but activation blocked by a foreign daemon. Restore the CAS-protected previous configuration, or keep the saved configuration inactive."
				: removing
					? "This removes only Telegram credentials. Configured Discord and Slack adapters remain unchanged."
					: "This disables all globally configured notification adapters. It does not change a session-local preference.",
			width,
			"muted",
		);
		lines.push("");
		this.#renderActionList(
			lines,
			width,
			blocked
				? [
						{
							id: "confirm",
							label: "Restore previous configuration",
							description: "Safest default: restore only if the CAS receipt still matches.",
						},
						{
							id: "cancel",
							label: "Keep saved (inactive)",
							description: "Keep the saved configuration while this session remains blocked from activation.",
						},
					]
				: [
						{ id: "confirm", label: "Confirm", description: "Apply this explicit destructive action." },
						{ id: "cancel", label: "Cancel", description: "Return without changing configuration." },
					],
		);
		return lines;
	}

	#renderSummary(width: number): string[] {
		const { status, session, health } = this.#state;
		const lines = [theme.bold(theme.fg("accent", "Notifications"))];
		lines.push(
			this.#truncate(
				`  Global: ${status.enabled ? "enabled" : "disabled"} · configured: ${status.globallyConfigured ? "yes" : "no"} · Telegram: ${
					status.telegram.configured ? "configured" : "not configured"
				}`,
				width,
			),
		);
		lines.push(
			this.#truncate(
				`  Session: ${session.effectiveEnabled ? "ACTIVE" : "inactive"} · local: ${session.locallyEnabled ? "on" : "off"} · runtime: ${
					session.running ? "running" : "stopped"
				} · environment: ${session.environment}`,
				width,
			),
		);
		if (width >= 100) {
			lines.push(
				this.#truncate(
					`  Telegram identity: ${status.telegram.botTokenMasked} · fingerprint: ${status.telegram.tokenFingerprint ?? "(not set)"} · chat: ${
						status.telegram.channel ?? "(not set)"
					}`,
					width,
				),
			);
		}
		if (health && width >= 120) {
			lines.push(
				this.#truncate(
					`  Health: ${statusLabel(health.overall)} · heartbeat: ${formatTimestamp(health.daemon.heartbeatAt)} (${formatAge(
						health.daemon.heartbeatAgeMs,
					)})`,
					width,
				),
			);
			lines.push(
				this.#truncate(
					`  Daemon: ${health.daemon.ownerId ?? "none"} pid ${health.daemon.pid ?? "unknown"} · generation ${
						health.daemon.generation ?? "unknown"
					}/${health.daemon.currentGeneration} (${health.daemon.generationRelation})`,
					width,
				),
			);
			lines.push(
				this.#truncate(
					`  Endpoints: ${health.endpoints.total} total, ${health.endpoints.live} live, ${health.endpoints.dead} dead, ${
						health.endpoints.unknown
					} unknown · reachability: ${health.reachability.probed ? (health.reachability.ok ? "OK" : "ERROR") : "not probed"}`,
					width,
				),
			);
		}
		if (this.#lastTest && width >= 120) {
			lines.push(
				this.#truncate(
					`  Last in-editor test: ${this.#lastTest.ok ? "OK" : "ERROR"} — ${safeDetail(this.#lastTest.detail, "No detail returned.")}`,
					width,
				),
			);
		}
		return lines;
	}

	#renderActionList(lines: string[], width: number, actions: readonly Action[]): void {
		if (actions.length === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, actions.length - 1));
		const start = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(VISIBLE_ACTIONS / 2), actions.length - VISIBLE_ACTIONS),
		);
		const end = Math.min(actions.length, start + VISIBLE_ACTIONS);
		for (let index = start; index < end; index += 1) {
			const action = actions[index];
			if (!action) continue;
			const selected = index === this.#selectedIndex;
			const prefix = selected ? `${theme.symbol("nav.cursor")} ` : "  ";
			const label = selected ? theme.bold(theme.fg("accent", action.label)) : theme.fg("text", action.label);
			lines.push(this.#truncate(prefix + label, width));
		}
		if (start > 0 || end < actions.length)
			lines.push(theme.fg("dim", this.#truncate(`  (${this.#selectedIndex + 1}/${actions.length})`, width)));
		const selected = actions[this.#selectedIndex];
		if (selected) this.#appendWrapped(lines, selected.description, width, "dim", 1);
		this.#appendStatus(lines, width);
		lines.push(theme.fg("dim", this.#truncate("  Enter/Space action · ↑↓ move · Esc cancel", width)));
	}

	#appendStatus(lines: string[], width: number): void {
		const separator = " — ";
		const separatorIndex = this.#status.indexOf(separator);
		const label = separatorIndex === -1 ? this.#status : this.#status.slice(0, separatorIndex);
		const guidance = separatorIndex === -1 ? "" : this.#status.slice(separatorIndex + separator.length).trim();
		const color = this.#status.startsWith("OK")
			? "success"
			: this.#status.startsWith("WARNING") || this.#status.startsWith("ABORTED")
				? "warning"
				: this.#status.startsWith("ERROR")
					? "error"
					: "muted";

		lines.push(theme.fg(color, this.#truncate(`  ${label}`, width)));
		if (!guidance) return;
		for (const line of wrapTextWithAnsi(guidance, Math.max(1, width - 4))) {
			lines.push(theme.fg(color, `    ${line}`));
		}
	}

	#appendWrapped(
		lines: string[],
		text: string,
		width: number,
		color: "muted" | "dim",
		maxLines = Number.POSITIVE_INFINITY,
	): void {
		const wrapped = wrapTextWithAnsi(text, Math.max(1, width - 4));
		for (const line of wrapped.slice(0, maxLines)) lines.push(theme.fg(color, `  ${line}`));
	}

	#truncate(text: string, width: number): string {
		return truncateToWidth(text, Math.max(1, width));
	}

	#healthSummary(health: NotificationHealthReport): string {
		const first = health.checks.find(check => check.level === health.overall) ?? health.checks[0];
		return safeDetail(first?.detail, "Health refreshed.");
	}

	async #loadState(): Promise<void> {
		const sequence = ++this.#loadSequence;
		try {
			const state = await this.operations.loadState();
			if (this.#disposed || sequence !== this.#loadSequence) return;
			this.#state = state;
			if (state.health) this.#status = `${statusLabel(state.health.overall)} — ${this.#healthSummary(state.health)}`;
		} catch {
			if (this.#disposed || sequence !== this.#loadSequence) return;
			this.#status = "WARNING — Notification status is temporarily unavailable; refresh health to retry.";
		}
	}
}
