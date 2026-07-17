/**
 * Notification verbosity: the single truth for quiet / lean / verbose delivery.
 *
 * Three boundaries consume this module:
 *
 * - **Settings / file snapshot** (`settings.ts`, `config.ts` zod file boundary,
 *   the lightweight daemon YAML reader): unknown or missing values are forgiven
 *   to the `lean` default via {@link coerceNotificationVerbosity}.
 * - **Commands / wire** (`config-commands.ts`, inbound `config_command.verbosity`):
 *   only an exact lowercase `quiet` / `lean` / `verbose` is accepted via
 *   {@link parseNotificationVerbosityStrict}; anything else yields `undefined`
 *   so the caller can reject the recognized root instead of free-texting.
 * - **Runtime delivery policy**: frames are classified into a
 *   {@link VisibleDeliveryClass} and gated by {@link mayCreateVisiblePayload},
 *   which is **fail-closed** under `quiet` — only the four allowlisted visible
 *   classes may ever produce a user-visible adapter payload. Unknown / future
 *   frame types classify to `"silent"` and create no visible body under quiet.
 */

/** Canonical verbosity values, ordered quiet → lean → verbose. */
export const NOTIFICATION_VERBOSITY_VALUES = ["quiet", "lean", "verbose"] as const;

/** The verbosity union shared by settings, config, commands, and runtime. */
export type NotificationVerbosity = (typeof NOTIFICATION_VERBOSITY_VALUES)[number];

const VERBOSITY_SET: ReadonlySet<NotificationVerbosity> = new Set(NOTIFICATION_VERBOSITY_VALUES);

/**
 * Settings / file boundary coercion. Exact `quiet` / `lean` / `verbose` are
 * preserved; any other value (including `undefined`, numbers, objects, or
 * unknown strings) falls back to the `lean` default. This is deliberately
 * forgiving: a stale or hand-edited config file must never break startup.
 */
export function coerceNotificationVerbosity(value: unknown): NotificationVerbosity {
	if (typeof value === "string" && VERBOSITY_SET.has(value as NotificationVerbosity)) {
		return value as NotificationVerbosity;
	}
	return "lean";
}

/**
 * Command / wire boundary parse. Only an exact lowercase `quiet` / `lean` /
 * `verbose` is accepted and returned; any other input returns `undefined` so
 * the caller can surface a usage error for a *recognized* root rather than
 * silently coercing to `lean` or falling through to free text.
 */
export function parseNotificationVerbosityStrict(value: unknown): NotificationVerbosity | undefined {
	if (typeof value === "string" && VERBOSITY_SET.has(value as NotificationVerbosity)) {
		return value as NotificationVerbosity;
	}
	return undefined;
}

/**
 * Delivery classification for a frame relative to the quiet visible allowlist.
 *
 * - `action_ask`      — A1: an `action_needed` ask (ordinary or workflow-gate).
 * - `action_idle`     — A2: an `action_needed` idle / next-input-ready.
 * - `user_control_result` — A3: a user-initiated control command result.
 * - `explicit_attachment` — A4: an authorized explicit `telegram_send` attachment.
 * - `silent`          — everything else, including unknown / future frame types.
 *
 * Classification is **fail-closed**: any frame that does not positively match
 * an allowlisted class resolves to `silent`, so it can never create a visible
 * adapter payload under quiet.
 */
export type VisibleDeliveryClass =
	| "action_ask"
	| "action_idle"
	| "user_control_result"
	| "explicit_attachment"
	| "silent";

/** Input shape used to classify a frame into a {@link VisibleDeliveryClass}. */
export interface VisibleDeliveryInput {
	/** The bus frame type, e.g. `action_needed`, `turn_stream`, `config_update`. */
	frameType?: string;
	/** For `action_needed` frames: the action kind (`ask` or `idle`). */
	actionKind?: string;
	/** True when the frame is the direct result of a user-initiated command. */
	userInitiated?: boolean;
	/** True for an authorized explicit attachment (e.g. `telegram_send`, `!redact`). */
	explicitAttachment?: boolean;
}

/**
 * Classify a frame into a {@link VisibleDeliveryClass}. Fail-closed: unknown
 * or unrecognised frames resolve to `silent`.
 *
 * The `ask` and `idle` action kinds are matched case-insensitively; an
 * `action_needed` frame with any other kind is `silent` under quiet.
 */
export function classifyVisibleDelivery(input: VisibleDeliveryInput): VisibleDeliveryClass {
	if (input.explicitAttachment) return "explicit_attachment";
	if (input.userInitiated) return "user_control_result";

	const frameType = input.frameType;
	if (frameType === "action_needed") {
		const kind = typeof input.actionKind === "string" ? input.actionKind.toLowerCase() : "";
		if (kind === "ask") return "action_ask";
		if (kind === "idle") return "action_idle";
		return "silent";
	}

	// Any other frame type — including unknown / future frames — is silent.
	return "silent";
}

/**
 * Fail-closed visible-payload gate. Under `quiet`, only the four allowlisted
 * visible classes may produce a user-visible adapter payload; `silent` (and any
 * class not on the allowlist) is denied. Under `lean` and `verbose` the broader
 * delivery surface is preserved, so every class — including `silent`-classified
 * automatic content — is allowed (existing redact gates still apply upstream).
 */
export function mayCreateVisiblePayload(
	verbosity: NotificationVerbosity,
	deliveryClass: VisibleDeliveryClass,
): boolean {
	if (verbosity === "quiet") {
		return (
			deliveryClass === "action_ask" ||
			deliveryClass === "action_idle" ||
			deliveryClass === "user_control_result" ||
			deliveryClass === "explicit_attachment"
		);
	}
	return true;
}
