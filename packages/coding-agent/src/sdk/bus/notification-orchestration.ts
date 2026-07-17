import type { CasRestoreResult } from "../../config/atomic-yaml-patch";
import type { RawSettings, SettingsAtomicPatch, SettingsAtomicReceipt } from "../../config/settings";
import {
	getNotificationConfig,
	hasNonBlankValue,
	type NotificationSettingsReader,
	type NotificationSettingsSnapshot,
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
	commitAtomicBatchWithCurrent?(
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
	if (settings.commitAtomicBatchWithCurrent) return settings.commitAtomicBatchWithCurrent(buildPatches);
	const snapshot = settings.getNotificationSettingsSnapshot();
	const current: RawSettings = {
		notifications: {
			telegram: {
				activation: snapshot.telegram.activation,
			},
		},
	};
	return settings.commitAtomicBatch(await buildPatches(current));
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

export type CompleteNonTelegramAdapter = "discord" | "slack";

function completeNonTelegramAdapters(snapshot: NotificationSettingsSnapshot): CompleteNonTelegramAdapter[] {
	if (!snapshot.enabled) return [];
	const adapters: CompleteNonTelegramAdapter[] = [];
	if (
		hasNonBlankValue(snapshot.discord.botToken) &&
		hasNonBlankValue(snapshot.discord.applicationId) &&
		hasNonBlankValue(snapshot.discord.guildId) &&
		hasNonBlankValue(snapshot.discord.parentChannelId)
	) {
		adapters.push("discord");
	}
	if (
		hasNonBlankValue(snapshot.slack.botToken) &&
		hasNonBlankValue(snapshot.slack.appToken) &&
		hasNonBlankValue(snapshot.slack.workspaceId) &&
		hasNonBlankValue(snapshot.slack.channelId)
	) {
		adapters.push("slack");
	}
	return adapters;
}

export type SaveTelegramInactiveAvailability = { available: true };

/**
 * Telegram-specific activation markers let Save inactive preserve globally
 * enabled Discord and Slack adapters, so the action is always available.
 */
export function getSaveTelegramInactiveAvailability(
	_settings: NotificationSettingsReader,
): SaveTelegramInactiveAvailability {
	return { available: true };
}

export type SaveTelegramInactiveResult = { status: "saved_inactive"; receipt: SettingsAtomicReceipt };

/**
 * Atomically persist Telegram credentials with a non-secret inactive marker.
 * Global notifications are disabled only when Telegram is the sole complete adapter.
 */
export async function saveTelegramInactive(input: {
	settings: NotificationConfigurationWriter;
	botToken: string;
	chatId: string;
}): Promise<SaveTelegramInactiveResult> {
	if (!hasNonBlankValue(input.botToken) || !hasNonBlankValue(input.chatId)) {
		throw new TypeError("Saving inactive Telegram configuration requires a non-blank token and chat ID.");
	}
	const snapshot = input.settings.getNotificationSettingsSnapshot();
	const marker = createTelegramActivationMarker({
		botToken: input.botToken,
		chatId: input.chatId,
		state: "inactive",
		reason: "saved_inactive",
	});
	const receipt = await commitNotificationBatchWithCurrent(input.settings, current => {
		const markers = activationMarkersFromCurrent(current);
		markers[marker.identity] = marker;
		const patches: SettingsAtomicPatch[] = [
			{ path: "notifications.telegram.botToken", op: "set", value: input.botToken },
			{ path: "notifications.telegram.chatId", op: "set", value: input.chatId },
			{ path: "notifications.telegram.activation", op: "set", value: markers },
		];
		if (completeNonTelegramAdapters(snapshot).length === 0) {
			patches.push({ path: "notifications.enabled", op: "set", value: false });
		}
		return patches;
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
	const cfg = getNotificationConfig(input.settings);
	const otherAdapterRemains =
		(hasNonBlankValue(cfg.discord.botToken) &&
			hasNonBlankValue(cfg.discord.applicationId) &&
			hasNonBlankValue(cfg.discord.guildId) &&
			hasNonBlankValue(cfg.discord.parentChannelId)) ||
		(hasNonBlankValue(cfg.slack.botToken) &&
			hasNonBlankValue(cfg.slack.appToken) &&
			hasNonBlankValue(cfg.slack.workspaceId) &&
			hasNonBlankValue(cfg.slack.channelId));
	await input.removal.stopAndUnregister();
	const patches: SettingsAtomicPatch[] = [
		{ path: "notifications.telegram.botToken", op: "unset" },
		{ path: "notifications.telegram.chatId", op: "unset" },
		{ path: "notifications.telegram.activation", op: "unset" },
	];
	if (!otherAdapterRemains) patches.push({ path: "notifications.enabled", op: "set", value: false });
	const receipt = await input.settings.commitAtomicBatch(patches);
	return { receipt, globallyDisabled: !otherAdapterRemains };
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
	| { status: "activated"; reconnect: Exclude<TelegramDaemonReconnectOutcome, "blocked_identity"> }
	| {
			status: "blocked_identity";
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
export async function reconcileCommittedTelegramConfiguration(input: {
	receipt: SettingsAtomicReceipt;
	activation: TelegramPostCommitActivation;
	inactiveMarkerToClear?: TelegramActivationMarker;
}): Promise<PostCommitTelegramActivationResult> {
	const reconnect = await input.activation.reconnect();
	if (reconnect === "blocked_identity") {
		await input.activation.controller.enterBlockedRuntime();
		const inactiveReceipt = await input.activation.persistInactive(input.activation.marker);
		return {
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
	return { status: "activated", reconnect };
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
