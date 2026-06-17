/**
 * Boring, redacted chat strings. Every failure must be understandable without
 * leaking capability hints, preset names, or internal state (docs/telegram-remote.md).
 */

/**
 * Identical refusal for every unauthorized sender. Default-deny: no capability
 * hints, no enumeration, no preset names. Unknown commands from authorized
 * senders reuse this same boring shape via {@link MESSAGES.unknownCommand}.
 */
export const UNAUTHORIZED_REFUSAL = "Not authorized.";

export const MESSAGES = {
	unauthorized: UNAUTHORIZED_REFUSAL,
	unknownCommand: "Unknown command. Send /help for the command set.",
	help: [
		"Gajae-Code Telegram remote (operator button set).",
		"",
		"/sessions — list live/recent sessions",
		"/observe <sessionId> — bounded status for one session",
		"/presets — list approved session presets",
		"/start-session <presetId> [task] — start a session from an approved preset",
		"/stop <sessionId> — request a graceful stop (confirm required)",
		"/help — show this message",
	].join("\n"),

	// Onboarding for the Telegram-conventional /start command (authorized senders).
	start: [
		"Gajae-Code Telegram remote.",
		"",
		"A tiny, safe operator surface for session lifecycle and observation.",
		"Use the buttons under /sessions, or these commands:",
		"",
		"/sessions — list live/recent sessions",
		"/observe <sessionId> — bounded status for one session",
		"/presets — list approved session presets",
		"/start-session <presetId> [task] — start a session from an approved preset",
		"/stop <sessionId> — request a graceful stop (confirm required)",
		"/help — show the command set",
		"",
		"Note: this remote does not proactively notify; check with /sessions or the refresh button.",
	].join("\n"),

	// Callback toast answers (kept generic; never leak internal reasons).
	callbackDone: "Done.",
	callbackExpired: "Expired — send /sessions again.",
	callbackInvalid: "That button is no longer valid.",
	callbackCancelled: "Cancelled.",
	following: "Following.",
	muted: "Muted.",
	pushUnavailable: "Notifications are unavailable.",

	noPresets: "No presets configured.",
	presetNeedsTask: "Send the task for this preset.",
	// Usage hints (authorized senders, malformed arguments).
	startUsage: "Usage: /start-session <presetId> [task]",
	observeUsage: "Usage: /observe <sessionId>",
	stopUsage: "Usage: /stop <sessionId>",

	// Failure states — see docs/telegram-remote.md "Failure states".
	unknownPreset: "Unknown preset.",
	taskTooLong: "Task is too long.",
	sessionControlDisabled: "Session control is disabled.",
	sessionControlNotPermitted: "Session control is not permitted.",
	unknownSession: "No such session. Use /sessions to list.",
	activeTurnExists: "That session has an active turn. Try again later.",
	backendOffline: "Session backend is offline.",
	genericFailure: "Request could not be completed.",

	// Neutral marker when content is intentionally withheld on the PC.
	withheld: "(withheld on PC)",
	noSessions: "No sessions.",
} as const;
