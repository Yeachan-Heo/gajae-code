import type { CasRestoreResult } from "../../config/atomic-yaml-patch";
import type { RawSettings, SettingsAtomicPatch, SettingsAtomicReceipt } from "../../config/settings";
import { isProcessIncarnation, processIncarnation } from "../broker/process-incarnation";
import {
	getCurrentTelegramActivationMarker,
	getNotificationConfig,
	hasNonBlankValue,
	isProviderEffectivelyEnabled,
	type NotificationProvider,
	type NotificationSettingsReader,
	type ProviderSecretDisposition,
	readTelegramActivationMarkers,
	type TelegramActivationMarker,
	type TelegramActivationMarkers,
	type TelegramActivationReason,
	type TelegramActivationState,
	telegramActivationIdentity,
	tokenFingerprint,
} from "./config";
import {
	DAEMON_VERSION,
	type EnsureTelegramDaemonDetailedResult,
	readDaemonState,
	type TelegramDaemonFs,
} from "./telegram-daemon";

export type { TelegramActivationMarker, TelegramActivationMarkers, TelegramActivationReason, TelegramActivationState };
export { telegramActivationIdentity };

/** The identity relationship between a proposed Telegram configuration and a live daemon owner. */
export type ProposedTelegramIdentityStatus = "absent" | "same" | "foreign" | "unknown";

/**
 * Non-secret metadata about a daemon owner. Token fingerprints and the owner's
 * chat ID intentionally never cross this boundary. `chatDisplay`, when present,
 * is supplied by the caller from an already-approved proposed-chat display.
 */
export interface TelegramDaemonOwnerMetadata {
	ownerId: string;
	pid: number;
	generation?: number;
	chatDisplay?: string;
}

/** Secret-safe proposed-identity preflight outcome. */
export interface ProposedTelegramIdentity {
	status: ProposedTelegramIdentityStatus;
	owner?: TelegramDaemonOwnerMetadata;
}

export interface ProposedTelegramIdentityPreflightInput {
	settings: NotificationSettingsReader;
	botToken: string;
	chatId: string;
	/** A UI-approved display value for the proposed chat; never inferred from a foreign daemon state. */
	chatDisplay?: string;
	deps?: {
		fs?: TelegramDaemonFs;
		pidAlive?: (pid: number) => boolean;
		pidIncarnation?: (pid: number) => string | undefined;
	};
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validGeneration(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

/**
 * Compare a proposed identity with the current daemon owner without exposing a
 * token or token fingerprint. Invalid/unreadable state is deliberately
 * `unknown`, which callers must treat as cancel-by-default.
 */
export async function proposedTelegramIdentity(
	input: ProposedTelegramIdentityPreflightInput,
): Promise<ProposedTelegramIdentity> {
	if (!hasNonBlankValue(input.botToken) || !hasNonBlankValue(input.chatId)) return { status: "unknown" };

	try {
		const state = await readDaemonState(input.settings, input.deps?.fs);
		if (!state) return { status: "absent" };

		const metadata =
			typeof state.ownerId === "string" &&
			state.ownerId.trim().length > 0 &&
			validPositiveInteger(state.pid) &&
			validGeneration(state.generation)
				? {
						ownerId: state.ownerId,
						pid: state.pid,
						...(state.generation === undefined ? {} : { generation: state.generation }),
					}
				: undefined;
		if (
			!metadata ||
			state.version !== DAEMON_VERSION ||
			typeof state.tokenFingerprint !== "string" ||
			typeof state.chatId !== "string"
		) {
			return metadata ? { status: "unknown", owner: metadata } : { status: "unknown" };
		}

		const pidAlive = input.deps?.pidAlive ?? defaultPidAlive;
		if (!pidAlive(metadata.pid)) return { status: "absent" };
		const pidIncarnation = input.deps?.pidIncarnation ?? processIncarnation;
		const persistedIncarnation = state.incarnation;
		const currentIncarnation = pidIncarnation(metadata.pid);
		if (
			!isProcessIncarnation(persistedIncarnation) ||
			!isProcessIncarnation(currentIncarnation) ||
			persistedIncarnation !== currentIncarnation
		) {
			return { status: "absent" };
		}

		if (state.tokenFingerprint === tokenFingerprint(input.botToken) && state.chatId === input.chatId) {
			return {
				status: "same",
				owner: input.chatDisplay === undefined ? metadata : { ...metadata, chatDisplay: input.chatDisplay },
			};
		}
		return { status: "foreign", owner: metadata };
	} catch {
		return { status: "unknown" };
	}
}

export interface NotificationConfigurationWriter extends NotificationSettingsReader {
	commitAtomicBatch(patches: readonly SettingsAtomicPatch[]): Promise<SettingsAtomicReceipt>;
	commitAtomicBatchWithCurrent(
		buildPatches: (
			current: Readonly<RawSettings>,
		) => Promise<readonly SettingsAtomicPatch[]> | readonly SettingsAtomicPatch[],
	): Promise<SettingsAtomicReceipt>;
}

export function createTelegramActivationMarker(input: {
	botToken: string;
	chatId: string;
	state: TelegramActivationState;
	reason?: TelegramActivationReason;
	now?: Date;
}): TelegramActivationMarker {
	return {
		identity: telegramActivationIdentity(input.botToken, input.chatId),
		state: input.state,
		updatedAt: (input.now ?? new Date()).toISOString(),
		...(input.reason === undefined ? {} : { reason: input.reason }),
	};
}

export function observedTelegramActivationMarker(
	settings: NotificationSettingsReader,
	botToken: string,
	chatId: string,
): TelegramActivationMarker | undefined {
	const identity = telegramActivationIdentity(botToken, chatId);
	return readTelegramActivationMarkers(settings.getNotificationSettingsSnapshot().telegram.activation)[identity];
}

function activationMarkersFromCurrent(current: Readonly<RawSettings>): TelegramActivationMarkers {
	const notifications = current.notifications;
	if (!notifications || typeof notifications !== "object" || Array.isArray(notifications)) return {};
	const telegram = (notifications as Record<string, unknown>).telegram;
	if (!telegram || typeof telegram !== "object" || Array.isArray(telegram)) return {};
	return readTelegramActivationMarkers((telegram as Record<string, unknown>).activation);
}

async function commitNotificationBatchWithCurrent(
	settings: NotificationConfigurationWriter,
	buildPatches: (
		current: Readonly<RawSettings>,
	) => Promise<readonly SettingsAtomicPatch[]> | readonly SettingsAtomicPatch[],
): Promise<SettingsAtomicReceipt> {
	return settings.commitAtomicBatchWithCurrent(buildPatches);
}

function sameActivationMarker(left: TelegramActivationMarker, right: TelegramActivationMarker): boolean {
	return (
		left.identity === right.identity &&
		left.state === right.state &&
		left.updatedAt === right.updatedAt &&
		left.reason === right.reason
	);
}

/** Persist one durable marker without discarding markers for other identities. */
export async function persistTelegramActivationMarker(
	settings: NotificationConfigurationWriter,
	marker: TelegramActivationMarker,
): Promise<SettingsAtomicReceipt> {
	return await commitNotificationBatchWithCurrent(settings, current => {
		const markers = activationMarkersFromCurrent(current);
		markers[marker.identity] = { ...marker };
		return [{ path: "notifications.telegram.activation", op: "set", value: markers }];
	});
}

/** Clear only the exact marker that was safely reconciled. */
export async function clearTelegramActivationMarker(
	settings: NotificationConfigurationWriter,
	marker: TelegramActivationMarker,
): Promise<void> {
	const receipt = await commitNotificationBatchWithCurrent(settings, current => {
		const markers = activationMarkersFromCurrent(current);
		const stored = markers[marker.identity];
		if (!stored || !sameActivationMarker(stored, marker)) return [];
		delete markers[marker.identity];
		return Object.keys(markers).length === 0
			? [{ path: "notifications.telegram.activation", op: "unset" }]
			: [{ path: "notifications.telegram.activation", op: "set", value: markers }];
	});
	receipt.discard();
}

export type SaveTelegramInactiveAvailability = { available: true };

/** Telegram activation markers make Save inactive independent of sibling providers. */
export function getSaveTelegramInactiveAvailability(
	_settings: NotificationSettingsReader,
): SaveTelegramInactiveAvailability {
	return { available: true };
}

export type SaveTelegramInactiveResult = { status: "saved_inactive"; receipt: SettingsAtomicReceipt };

/** Atomically persist Telegram credentials, desired-off intent, and its inactive marker. */
export async function saveTelegramInactive(input: {
	settings: NotificationConfigurationWriter;
	botToken: string;
	chatId: string;
}): Promise<SaveTelegramInactiveResult> {
	if (!hasNonBlankValue(input.botToken) || !hasNonBlankValue(input.chatId)) {
		throw new TypeError("Saving inactive Telegram configuration requires a non-blank token and chat ID.");
	}
	const marker = createTelegramActivationMarker({
		botToken: input.botToken,
		chatId: input.chatId,
		state: "inactive",
		reason: "saved_inactive",
	});
	const receipt = await commitNotificationBatchWithCurrent(input.settings, current => {
		const markers = activationMarkersFromCurrent(current);
		markers[marker.identity] = marker;
		return [
			{ path: "notifications.telegram.botToken", op: "set", value: input.botToken },
			{ path: "notifications.telegram.chatId", op: "set", value: input.chatId },
			{ path: "notifications.telegram.enabled", op: "set", value: false },
			{ path: "notifications.telegram.activation", op: "set", value: markers },
		];
	});
	return { status: "saved_inactive", receipt };
}

export interface TelegramRemovalRuntime {
	/** Stops the local endpoint, unregisters its root, and stops an unreferenced old daemon. */
	stopAndUnregister(): Promise<void>;
}

/**
 * Remove Telegram credentials without disturbing other adapters. Runtime
 * teardown is intentionally first: a failed teardown leaves durable credentials
 * untouched rather than orphaning an old daemon/root behind a successful delete.
 */
export async function removeTelegramConfiguration(input: {
	settings: NotificationConfigurationWriter;
	removal: TelegramRemovalRuntime;
}): Promise<{ receipt: SettingsAtomicReceipt; globallyDisabled: boolean }> {
	await input.removal.stopAndUnregister();
	const receipt = await input.settings.commitAtomicBatch([
		{ path: "notifications.telegram.botToken", op: "unset" },
		{ path: "notifications.telegram.chatId", op: "unset" },
		{ path: "notifications.telegram.activation", op: "unset" },
		{ path: "notifications.telegram.enabled", op: "set", value: false },
	]);
	return { receipt, globallyDisabled: false };
}

/** Detailed outcome of checking or reconnecting the Telegram daemon after a durable commit. */
export type TelegramDaemonReconnectOutcome = EnsureTelegramDaemonDetailedResult;

/**
 * The session controller must not resolve `enterBlockedRuntime` until its
 * current endpoint has stopped and been removed. This lets callers report a
 * blocked save only after no further frames can reach the foreign owner.
 */
export interface NotificationRuntimeController {
	/** Resolves only after the current endpoint is stopped and removed. */
	enterBlockedRuntime(): Promise<unknown>;
	clearBlockedRuntime(): Promise<unknown>;
	reconcileCurrentSession(): Promise<unknown>;
}

export interface TelegramPostCommitActivation {
	controller: NotificationRuntimeController;
	reconnect: () => Promise<TelegramDaemonReconnectOutcome>;
	/** Durable Telegram-only marker write after the endpoint has stopped. */
	persistInactive(marker: TelegramActivationMarker): Promise<SettingsAtomicReceipt>;
	/** Remove the exact activation marker only after a safe reconnect. */
	clearInactive(marker: TelegramActivationMarker): Promise<void>;
	marker: TelegramActivationMarker;
}

export type PostCommitTelegramActivationResult =
	| {
			status: "activated";
			receipt: SettingsAtomicReceipt;
			reconnect: Exclude<TelegramDaemonReconnectOutcome, "blocked_identity" | "disabled">;
	  }
	| {
			status: "activation_failed";
			receipt: SettingsAtomicReceipt;
			reconnect?: TelegramDaemonReconnectOutcome;
			message: string;
	  }
	| {
			status: "blocked_identity";
			receipt: SettingsAtomicReceipt;
			message: string;
			restore(): Promise<BlockedTelegramRestoreResult>;
			retainCommitted(): void;
	  };

export type BlockedTelegramRestoreResult =
	| { status: "restored"; reconnect: TelegramDaemonReconnectOutcome }
	| { status: "conflict"; paths: readonly string[] }
	| { status: "discarded" }
	| { status: "still_blocked" };

async function restoreBlockedConfiguration(input: {
	receipt: SettingsAtomicReceipt;
	inactiveReceipt: SettingsAtomicReceipt;
	activation: TelegramPostCommitActivation;
}): Promise<BlockedTelegramRestoreResult> {
	const retainBlockedMarker = async (): Promise<void> => {
		const receipt = await input.activation.persistInactive(input.activation.marker);
		receipt.discard();
	};

	let restored: CasRestoreResult;
	try {
		restored = await input.receipt.restore();
	} catch (error) {
		await retainBlockedMarker();
		throw error;
	}
	if (restored.status === "conflict" || restored.status === "discarded") {
		await retainBlockedMarker();
		return restored;
	}

	// Keep the fail-closed marker durable until the configuration rollback has
	// completed. Removing it first exposes the blocked identity between two CAS
	// operations to other processes.
	let inactiveRestored: CasRestoreResult;
	try {
		inactiveRestored = await input.inactiveReceipt.restore();
	} catch (error) {
		await retainBlockedMarker();
		throw error;
	}
	if (inactiveRestored.status === "conflict" || inactiveRestored.status === "discarded") {
		await retainBlockedMarker();
		await input.activation.controller.enterBlockedRuntime();
		return { status: "still_blocked" };
	}

	const reconnect = await input.activation.reconnect();
	if (reconnect === "blocked_identity") {
		await input.activation.controller.enterBlockedRuntime();
		return { status: "still_blocked" };
	}
	await input.activation.controller.clearBlockedRuntime();
	await input.activation.controller.reconcileCurrentSession();
	return { status: "restored", reconnect };
}

/**
 * Complete a committed Telegram update in the required order: identity
 * reconnect first, normal session reconciliation second. A post-commit foreign
 * owner race stops the endpoint, durably marks only that Telegram identity
 * inactive, then exposes an ordered CAS restore/retain choice.
 */
async function reconcileCommittedTelegramConfigurationUnsafe(input: {
	receipt: SettingsAtomicReceipt;
	activation: TelegramPostCommitActivation;
	inactiveMarkerToClear?: TelegramActivationMarker;
}): Promise<PostCommitTelegramActivationResult> {
	const reconnect = await input.activation.reconnect();
	if (reconnect === "blocked_identity") {
		await input.activation.controller.enterBlockedRuntime();
		const inactiveReceipt = await input.activation.persistInactive(input.activation.marker);
		return {
			receipt: input.receipt,
			status: "blocked_identity",
			message:
				"Configuration saved inactive; activation blocked; foreign daemon untouched. Current session stopped because Telegram activation was blocked by a foreign daemon.",
			restore: () => restoreBlockedConfiguration({ ...input, inactiveReceipt }),
			retainCommitted: () => {
				inactiveReceipt.discard();
				input.receipt.discard();
			},
		};
	}
	if (reconnect === "disabled") {
		await input.activation.controller.enterBlockedRuntime();
		return {
			receipt: input.receipt,
			status: "activation_failed",
			reconnect,
			message: "Configuration and desired intent were saved, but Telegram runtime activation did not become ready.",
		};
	}

	if (input.inactiveMarkerToClear) {
		try {
			await input.activation.clearInactive(input.inactiveMarkerToClear);
		} catch (error) {
			await input.activation.controller.enterBlockedRuntime();
			throw error;
		}
	}
	await input.activation.controller.clearBlockedRuntime();
	await input.activation.controller.reconcileCurrentSession();
	return { status: "activated", receipt: input.receipt, reconnect };
}

export async function reconcileCommittedTelegramConfiguration(input: {
	receipt: SettingsAtomicReceipt;
	activation: TelegramPostCommitActivation;
	inactiveMarkerToClear?: TelegramActivationMarker;
}): Promise<PostCommitTelegramActivationResult> {
	try {
		return await reconcileCommittedTelegramConfigurationUnsafe(input);
	} catch {
		let fenced = false;
		try {
			await input.activation.controller.enterBlockedRuntime();
			fenced = true;
		} catch {
			fenced = false;
		}
		return {
			status: "activation_failed",
			receipt: input.receipt,
			message: fenced
				? "Configuration and desired intent were saved, but post-commit activation or reconciliation failed; the current runtime was fenced."
				: "Configuration and desired intent were saved, but post-commit activation or reconciliation failed and the current runtime could not be fenced.",
		};
	}
}

export type SaveTelegramConfigurationResult =
	| { status: "cancelled"; preflight: ProposedTelegramIdentity; guidance: string }
	| SaveTelegramInactiveResult
	| { status: "saved"; receipt: SettingsAtomicReceipt; preflight: ProposedTelegramIdentity }
	| PostCommitTelegramActivationResult;

/**
 * Guard a Telegram setup commit with proposed-identity preflight. Foreign and
 * unreadable ownership are cancel-by-default and make no configuration changes.
 */
export async function saveTelegramConfiguration(input: {
	settings: NotificationConfigurationWriter;
	botToken: string;
	chatId: string;
	chatDisplay?: string;
	/** Explicitly persist credentials disabled after a foreign/unknown preflight; otherwise cancel remains the default. */
	saveInactive: boolean;
	preflight?: (input: Omit<ProposedTelegramIdentityPreflightInput, "settings">) => Promise<ProposedTelegramIdentity>;
	activation?: TelegramPostCommitActivation;
}): Promise<SaveTelegramConfigurationResult> {
	if (!hasNonBlankValue(input.botToken) || !hasNonBlankValue(input.chatId)) {
		throw new TypeError("Saving Telegram configuration requires a non-blank token and chat ID.");
	}
	const runPreflight =
		input.preflight ??
		((next: Omit<ProposedTelegramIdentityPreflightInput, "settings">) =>
			proposedTelegramIdentity({ settings: input.settings, ...next }));
	const preflight = await runPreflight({
		botToken: input.botToken,
		chatId: input.chatId,
		chatDisplay: input.chatDisplay,
	});
	if (preflight.status === "foreign" || preflight.status === "unknown") {
		// Cancel is the default for an untrusted owner. `saveInactive` is an
		// explicit user selection that cannot activate the proposed identity.
		if (input.saveInactive) return await saveTelegramInactive(input);
		return {
			status: "cancelled",
			preflight,
			guidance:
				"Telegram activation was not saved. Cancel or retry after the daemon owner exits or is reconfigured.",
		};
	}

	if (input.saveInactive) return await saveTelegramInactive(input);

	const activeIdentity = telegramActivationIdentity(input.botToken, input.chatId);
	const inactiveMarkerToClear = observedTelegramActivationMarker(input.settings, input.botToken, input.chatId);
	const receipt = await commitNotificationBatchWithCurrent(input.settings, current => {
		const patches: SettingsAtomicPatch[] = [
			{ path: "notifications.telegram.botToken", op: "set", value: input.botToken },
			{ path: "notifications.telegram.chatId", op: "set", value: input.chatId },
			{ path: "notifications.enabled", op: "set", value: true },
			{ path: "notifications.telegram.enabled", op: "set", value: true },
		];
		// With post-commit activation, the marker has its own receipt so a blocked
		// rollback can restore configuration without self-conflicting on the marker
		// written after this commit. Successful activation clears that marker only
		// after owner readiness is proved.
		if (!input.activation) {
			const markers = activationMarkersFromCurrent(current);
			delete markers[activeIdentity];
			patches.splice(
				2,
				0,
				Object.keys(markers).length === 0
					? { path: "notifications.telegram.activation", op: "unset" }
					: { path: "notifications.telegram.activation", op: "set", value: markers },
			);
		}
		return patches;
	});
	if (!input.activation) return { status: "saved", receipt, preflight };
	return await reconcileCommittedTelegramConfiguration({
		receipt,
		activation: input.activation,
		inactiveMarkerToClear,
	});
}

export type ProviderSecretMutation = { action: "keep" } | { action: "replace"; value: string } | { action: "remove" };

export interface TelegramProviderConfigurationMutation {
	provider: "telegram";
	botToken: ProviderSecretMutation;
	chatId?: string;
	richEnabled?: boolean;
	richDraftEnabled?: boolean;
	streamingEnabled?: boolean;
}

export interface DiscordProviderConfigurationMutation {
	provider: "discord";
	botToken: ProviderSecretMutation;
	applicationId?: string;
	guildId?: string;
	parentChannelId?: string;
}

export interface SlackProviderConfigurationMutation {
	provider: "slack";
	botToken: ProviderSecretMutation;
	appToken: ProviderSecretMutation;
	workspaceId?: string;
	channelId?: string;
	authorizedUserId?: string | null;
}

export type NotificationProviderConfigurationMutation =
	| TelegramProviderConfigurationMutation
	| DiscordProviderConfigurationMutation
	| SlackProviderConfigurationMutation;

export interface NotificationProviderRuntimeAuthority {
	activate(provider: NotificationProvider): Promise<void>;
	deactivate(provider: NotificationProvider): Promise<void>;
}

export type NotificationProviderMutationResult =
	| { status: "saved"; receipt: SettingsAtomicReceipt; observerFailed: boolean }
	| { status: "activated"; receipt: SettingsAtomicReceipt; observerFailed: boolean }
	| { status: "activation_failed"; receipt: SettingsAtomicReceipt; observerFailed: boolean }
	| { status: "deactivation_failed"; receipt: SettingsAtomicReceipt; observerFailed: boolean }
	| { status: "commit_failed" };

function secretMutationPatches(
	pathName:
		| "notifications.telegram.botToken"
		| "notifications.discord.botToken"
		| "notifications.slack.botToken"
		| "notifications.slack.appToken",
	mutation: ProviderSecretMutation,
): SettingsAtomicPatch[] {
	if (mutation.action === "keep") return [];
	if (mutation.action === "remove") return [{ path: pathName, op: "unset" }];
	if (!hasNonBlankValue(mutation.value)) throw new TypeError(`A non-blank replacement is required for ${pathName}.`);
	return [{ path: pathName, op: "set", value: mutation.value }];
}

function optionalSet(pathName: SettingsAtomicPatch["path"], value: unknown): SettingsAtomicPatch[] {
	return value === undefined ? [] : [{ path: pathName, op: "set", value }];
}

function selectedProviderPatches(mutation: NotificationProviderConfigurationMutation): SettingsAtomicPatch[] {
	if (mutation.provider === "telegram") {
		return [
			...secretMutationPatches("notifications.telegram.botToken", mutation.botToken),
			...optionalSet("notifications.telegram.chatId", mutation.chatId),
			...optionalSet("notifications.telegram.rich.enabled", mutation.richEnabled),
			...optionalSet("notifications.telegram.richDraft.enabled", mutation.richDraftEnabled),
			...optionalSet("notifications.telegram.streaming.enabled", mutation.streamingEnabled),
		];
	}
	if (mutation.provider === "discord") {
		return [
			...secretMutationPatches("notifications.discord.botToken", mutation.botToken),
			...optionalSet("notifications.discord.applicationId", mutation.applicationId),
			...optionalSet("notifications.discord.guildId", mutation.guildId),
			...optionalSet("notifications.discord.parentChannelId", mutation.parentChannelId),
		];
	}
	return [
		...secretMutationPatches("notifications.slack.botToken", mutation.botToken),
		...secretMutationPatches("notifications.slack.appToken", mutation.appToken),
		...optionalSet("notifications.slack.workspaceId", mutation.workspaceId),
		...optionalSet("notifications.slack.channelId", mutation.channelId),
		...(mutation.authorizedUserId === undefined
			? []
			: mutation.authorizedUserId === null
				? [{ path: "notifications.slack.authorizedUserId", op: "unset" } as const]
				: optionalSet("notifications.slack.authorizedUserId", mutation.authorizedUserId)),
	];
}

function providerDesiredPath(provider: NotificationProvider): SettingsAtomicPatch["path"] {
	if (provider === "telegram") return "notifications.telegram.enabled";
	if (provider === "discord") return "notifications.discord.enabled";
	return "notifications.slack.enabled";
}

function mutationRemovesRequiredSecret(mutation: NotificationProviderConfigurationMutation): boolean {
	if (mutation.provider === "telegram" || mutation.provider === "discord")
		return mutation.botToken.action === "remove";
	return mutation.botToken.action === "remove" || mutation.appToken.action === "remove";
}

/**
 * Sole CAS-backed provider configuration authority. It commits one selected-provider
 * batch before observer/runtime effects and never reports rollback after a durable save.
 */
export async function mutateNotificationProvider(input: {
	settings: NotificationConfigurationWriter;
	mutation: NotificationProviderConfigurationMutation;
	desiredEnabled?: boolean;
	configureAndActivate?: boolean;
	notifyConfigChanged?: () => Promise<void> | void;
	redact?: boolean;
	runtime?: NotificationProviderRuntimeAuthority;
	signal?: AbortSignal;
}): Promise<NotificationProviderMutationResult> {
	if (input.signal?.aborted) return { status: "commit_failed" };
	const provider = input.mutation.provider;
	const removesRequiredSecret = mutationRemovesRequiredSecret(input.mutation);
	const desiredEnabled = removesRequiredSecret ? false : input.desiredEnabled;
	const activate = input.configureAndActivate === true && !removesRequiredSecret;
	const patches = selectedProviderPatches(input.mutation);
	if (activate) {
		patches.push(
			{ path: "notifications.enabled", op: "set", value: true },
			{ path: providerDesiredPath(provider), op: "set", value: true },
		);
	} else if (desiredEnabled !== undefined) {
		patches.push({ path: providerDesiredPath(provider), op: "set", value: desiredEnabled });
	}
	if (input.redact !== undefined) patches.push({ path: "notifications.redact", op: "set", value: input.redact });
	let receipt: SettingsAtomicReceipt;
	try {
		receipt = await input.settings.commitAtomicBatch(patches);
	} catch {
		return { status: "commit_failed" };
	}
	let observerFailed = false;
	try {
		await input.notifyConfigChanged?.();
	} catch {
		observerFailed = true;
	}
	if (!input.runtime) return { status: "saved", receipt, observerFailed };
	try {
		if (activate || desiredEnabled === true) {
			await input.runtime.activate(provider);
			return { status: "activated", receipt, observerFailed };
		}
		if (desiredEnabled === false) {
			await input.runtime.deactivate(provider);
		}
		return { status: "saved", receipt, observerFailed };
	} catch {
		return {
			status: activate || desiredEnabled === true ? "activation_failed" : "deactivation_failed",
			receipt,
			observerFailed,
		};
	}
}

export type NotificationProviderRemovalResult =
	| { status: "removed"; receipt: SettingsAtomicReceipt; observerFailed: boolean }
	| { status: "deactivation_failed"; receipt?: SettingsAtomicReceipt; observerFailed?: boolean }
	| { status: "commit_failed_after_teardown" }
	| { status: "commit_failed" };

function providerRemovalPatches(provider: NotificationProvider): SettingsAtomicPatch[] {
	if (provider === "telegram") {
		return [
			{ path: "notifications.telegram.botToken", op: "unset" },
			{ path: "notifications.telegram.chatId", op: "unset" },
			{ path: "notifications.telegram.activation", op: "unset" },
			{ path: "notifications.telegram.enabled", op: "set", value: false },
		];
	}
	if (provider === "discord") {
		return [
			{ path: "notifications.discord.botToken", op: "unset" },
			{ path: "notifications.discord.applicationId", op: "unset" },
			{ path: "notifications.discord.guildId", op: "unset" },
			{ path: "notifications.discord.parentChannelId", op: "unset" },
			{ path: "notifications.discord.enabled", op: "set", value: false },
		];
	}
	return [
		{ path: "notifications.slack.botToken", op: "unset" },
		{ path: "notifications.slack.appToken", op: "unset" },
		{ path: "notifications.slack.workspaceId", op: "unset" },
		{ path: "notifications.slack.channelId", op: "unset" },
		{ path: "notifications.slack.authorizedUserId", op: "unset" },
		{ path: "notifications.slack.enabled", op: "set", value: false },
	];
}

/** Remove only one provider. Telegram keeps teardown-before-delete; chat providers deactivate after commit. */
export async function removeNotificationProvider(input: {
	settings: NotificationConfigurationWriter;
	provider: NotificationProvider;
	runtime: NotificationProviderRuntimeAuthority;
	notifyConfigChanged?: () => Promise<void> | void;
}): Promise<NotificationProviderRemovalResult> {
	if (input.provider === "telegram") {
		try {
			await input.runtime.deactivate("telegram");
		} catch {
			return { status: "deactivation_failed" };
		}
	}
	let receipt: SettingsAtomicReceipt;
	try {
		receipt = await input.settings.commitAtomicBatch(providerRemovalPatches(input.provider));
	} catch {
		return { status: input.provider === "telegram" ? "commit_failed_after_teardown" : "commit_failed" };
	}
	let observerFailed = false;
	try {
		await input.notifyConfigChanged?.();
	} catch {
		observerFailed = true;
	}
	if (input.provider !== "telegram") {
		try {
			await input.runtime.deactivate(input.provider);
		} catch {
			return { status: "deactivation_failed", receipt, observerFailed };
		}
	}
	return { status: "removed", receipt, observerFailed };
}

export type GlobalNotificationMutationResult =
	| { status: "saved"; receipt: SettingsAtomicReceipt; observerFailed: boolean }
	| {
			status: "global_deactivation_partial";
			receipt: SettingsAtomicReceipt;
			failed: readonly NotificationProvider[];
			observerFailed: boolean;
	  }
	| {
			status: "global_activation_partial";
			receipt: SettingsAtomicReceipt;
			failed: readonly NotificationProvider[];
			observerFailed: boolean;
	  }
	| { status: "commit_failed" };

/** Toggle only the global master. Provider configuration and desired intent are preserved. */
export async function setGlobalNotificationsEnabled(input: {
	settings: NotificationConfigurationWriter;
	enabled: boolean;
	runtime?: NotificationProviderRuntimeAuthority;
	notifyConfigChanged?: () => Promise<void> | void;
}): Promise<GlobalNotificationMutationResult> {
	let receipt: SettingsAtomicReceipt;
	try {
		receipt = await input.settings.commitAtomicBatch([
			{ path: "notifications.enabled", op: "set", value: input.enabled },
		]);
	} catch {
		return { status: "commit_failed" };
	}
	let observerFailed = false;
	try {
		await input.notifyConfigChanged?.();
	} catch {
		observerFailed = true;
	}
	if (!input.runtime) return { status: "saved", receipt, observerFailed };
	const failed: NotificationProvider[] = [];
	if (input.enabled) {
		const cfg = getNotificationConfig(input.settings);
		for (const provider of ["telegram", "discord", "slack"] as const) {
			if (!isProviderEffectivelyEnabled(cfg, provider)) continue;
			if (provider === "telegram" && getCurrentTelegramActivationMarker(cfg)) continue;
			try {
				await input.runtime.activate(provider);
			} catch {
				failed.push(provider);
			}
		}
		return failed.length === 0
			? { status: "saved", receipt, observerFailed }
			: { status: "global_activation_partial", receipt, failed, observerFailed };
	}
	for (const provider of ["telegram", "discord", "slack"] as const) {
		try {
			await input.runtime.deactivate(provider);
		} catch {
			failed.push(provider);
		}
	}
	return failed.length === 0
		? { status: "saved", receipt, observerFailed }
		: { status: "global_deactivation_partial", receipt, failed, observerFailed };
}

/** Safe helper for UI contracts that must retain only the disposition, never replacement material. */
export function providerSecretDisposition(mutation: ProviderSecretMutation): ProviderSecretDisposition {
	return mutation.action;
}
