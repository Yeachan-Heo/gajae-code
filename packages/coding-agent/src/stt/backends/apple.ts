/**
 * Apple on-device speech backend (macOS).
 *
 * Wraps the `@gajae-code/natives` `MacSpeechSession` binding: streaming
 * partial transcripts, live input levels, on-device-only recognition, and
 * `contextualStrings` vocabulary bias. No Python, no model download — the
 * OS provides the recognizer.
 */

import {
	MacSpeechSession,
	macSpeechAuthorizationStatus,
	macSpeechRequestAuthorization,
	macSpeechSupport,
} from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import type { SttBackend, SttSession, SttStartOptions } from "./types";

/** Final-result grace period after `stop()` before giving up on the recognizer. */
const FINAL_RESULT_TIMEOUT_MS = 15_000;

/**
 * Map the short `stt.language` code onto a concrete recognizer locale.
 * Full BCP-47 tags pass through untouched; unknown short codes are handed
 * to the recognizer as-is (it resolves regional defaults itself).
 */
const LOCALE_BY_LANGUAGE: Record<string, string> = {
	ar: "ar-SA",
	de: "de-DE",
	en: "en-US",
	es: "es-ES",
	fr: "fr-FR",
	hi: "hi-IN",
	it: "it-IT",
	ja: "ja-JP",
	ko: "ko-KR",
	nl: "nl-NL",
	pt: "pt-BR",
	ru: "ru-RU",
	zh: "zh-CN",
};

export function appleLocaleForLanguage(language: string | undefined): string | undefined {
	if (!language) return undefined;
	const trimmed = language.trim();
	if (!trimmed || trimmed === "auto") return undefined;
	if (trimmed.includes("-") || trimmed.includes("_")) return trimmed.replace("_", "-");
	return LOCALE_BY_LANGUAGE[trimmed.toLowerCase()] ?? trimmed;
}

export type AppleAuthorization = "authorized" | "denied" | "restricted" | "notDetermined";

/**
 * Some recognizer failures are only observable at runtime (e.g. Dictation
 * disabled in System Settings while `isAvailable` still reports true). Once
 * seen, auto-selection degrades to whisper for the rest of the process.
 */
let runtimeDegradedReason: string | null = null;

export function appleRuntimeDegradedReason(): string | null {
	return runtimeDegradedReason;
}

/** Translate known recognizer failures into actionable guidance. */
export function describeAppleSpeechError(message: string): string {
	if (/siri and dictation are disabled|dictation is disabled/i.test(message)) {
		return "Apple speech requires Dictation: enable it in System Settings → Keyboard → Dictation (or set stt.backend to whisper).";
	}
	return message;
}

export interface AppleAvailability {
	usable: boolean;
	/** Machine-readable reason when unusable (for fallback notes). */
	reason?: "platform" | "locale" | "assets" | "on-device" | "permission";
	authorization: AppleAuthorization;
}

/** Capability probe — cheap, no permission prompt. */
export function appleBackendAvailability(language?: string): AppleAvailability {
	const support = macSpeechSupport(appleLocaleForLanguage(language));
	const authorization = (macSpeechAuthorizationStatus() ?? "notDetermined") as AppleAuthorization;
	if (!support.platform) return { usable: false, reason: "platform", authorization };
	if (!support.locale) return { usable: false, reason: "locale", authorization };
	if (!support.available) return { usable: false, reason: "assets", authorization };
	if (!support.onDevice) return { usable: false, reason: "on-device", authorization };
	if (authorization === "denied" || authorization === "restricted") {
		return { usable: false, reason: "permission", authorization };
	}
	return { usable: true, authorization };
}

/**
 * Resolve speech-recognition authorization, prompting the user once when
 * undetermined. Resolution is prompt-bound, so no artificial timeout here —
 * the native side already guards against a stuck decision.
 */
export function ensureAppleAuthorization(): Promise<AppleAuthorization> {
	const current = (macSpeechAuthorizationStatus() ?? "notDetermined") as AppleAuthorization;
	if (current !== "notDetermined") return Promise.resolve(current);
	return new Promise(resolve => {
		macSpeechRequestAuthorization((err, status) => {
			if (err) {
				logger.error("Apple speech authorization request failed", { error: String(err) });
				resolve("notDetermined");
				return;
			}
			resolve(status as AppleAuthorization);
		});
	});
}

class AppleSession implements SttSession {
	#native: MacSpeechSession;
	#finished = false;
	#lastPartial = "";
	#finalResolvers: PromiseWithResolvers<string> = Promise.withResolvers<string>();

	constructor(options: SttStartOptions) {
		this.#native = MacSpeechSession.start(
			{
				locale: appleLocaleForLanguage(options.language),
				onDeviceOnly: true,
				contextualStrings: options.vocabulary ? [...options.vocabulary] : undefined,
				punctuation: true,
			},
			(err, event) => {
				if (err) {
					this.#fail(String(err), options);
					return;
				}
				switch (event.kind) {
					case "partial":
						this.#lastPartial = event.text ?? "";
						options.onPartial?.(this.#lastPartial);
						break;
					case "level":
						options.onLevel?.(event.level ?? 0);
						break;
					case "final":
						this.#finished = true;
						// Recognizers can deliver an empty terminal result even after
						// streaming partials (observed live) — never lose spoken text.
						this.#finalResolvers.resolve(event.text?.trim() ? event.text : this.#lastPartial);
						break;
					case "error":
						this.#fail(event.message ?? "speech recognition failed", options);
						break;
				}
			},
		);
		// Swallow unhandled-rejection noise when the session is cancelled
		// before anyone awaits stop().
		this.#finalResolvers.promise.catch(() => {});
	}

	#fail(message: string, options: SttStartOptions): void {
		if (this.#finished) return;
		this.#finished = true;
		logger.error("Apple speech session error", { message });
		if (/siri and dictation are disabled|dictation is disabled/i.test(message)) {
			runtimeDegradedReason = message;
		}
		// Release the microphone immediately — the session is dead.
		this.#native.cancel();
		const described = describeAppleSpeechError(message);
		this.#finalResolvers.reject(new Error(described));
		options.onError?.(described);
	}

	async stop(): Promise<string> {
		this.#native.stop();
		const timeout = setTimeout(() => {
			// The recognizer failed to deliver a terminal result — salvage the
			// last partial instead of hanging the UI.
			if (!this.#finished) {
				this.#finished = true;
				this.#finalResolvers.resolve(this.#lastPartial);
			}
		}, FINAL_RESULT_TIMEOUT_MS);
		try {
			return await this.#finalResolvers.promise;
		} finally {
			clearTimeout(timeout);
			this.#native.cancel();
		}
	}

	async cancel(): Promise<void> {
		this.#finished = true;
		this.#finalResolvers.reject(new Error("cancelled"));
		this.#native.cancel();
	}
}

export class AppleSttBackend implements SttBackend {
	readonly id = "apple" as const;
	readonly streaming = true;

	async start(options: SttStartOptions): Promise<SttSession> {
		const authorization = await ensureAppleAuthorization();
		if (authorization !== "authorized") {
			throw new Error(
				authorization === "notDetermined"
					? "Speech recognition permission was not granted."
					: "Speech recognition permission is denied. Enable it in System Settings → Privacy & Security → Speech Recognition.",
			);
		}
		return new AppleSession(options);
	}
}
