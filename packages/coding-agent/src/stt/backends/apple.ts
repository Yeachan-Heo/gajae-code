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
import { probeInProcessSpeechSafety } from "./apple-probe";
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
 * Extract the `.app` bundle root from an executable path inside it.
 * Returns null for non-bundle executables (plain CLI chains).
 */
export function bundlePathFromExecutablePath(execPath: string): string | null {
	const marker = ".app/Contents/MacOS/";
	const index = execPath.indexOf(marker);
	if (index === -1) return null;
	return execPath.slice(0, index + ".app".length);
}

let hostAppCheckCache: { fastNegative: boolean } | null = null;

/**
 * TCC crash preflight. macOS attributes speech/microphone permission to the
 * **responsible app** (the terminal hosting this process) and ABORTS the
 * requesting process when that app's Info.plist lacks the matching usage
 * description — observed in the field as a SIGABRT with
 * "must contain an NSSpeechRecognitionUsageDescription key". Walk the parent
 * chain to the hosting .app bundle and verify both keys BEFORE touching any
 * Speech API. Fail-open for non-bundle chains (plain CLI/ssh/tmux servers),
 * where macOS prompts normally instead of aborting.
 */
/**
 * Supported host classes for in-process Speech APIs (fail-closed).
 *
 * macOS attributes speech/microphone TCC to the hosting terminal (the
 * responsible process). A host whose Info.plist lacks
 * `NSSpeechRecognitionUsageDescription` gets the requesting process ABORTED
 * by TCC (observed live: SIGABRT), so eligibility must be provable, never
 * assumed:
 *
 * - `system`: bundle under /System — Apple system apps (Terminal.app);
 *   Speech APIs verified working there without usage descriptions.
 * - `described`: third-party bundle carrying BOTH usage-description keys.
 * - everything else — no bundle found, ancestry/parse failure, tmux or ssh
 *   chains, or a bundle missing keys — is NOT eligible; auto-selection uses
 *   whisper and forced `apple` fails with guidance instead of risking an
 *   in-process abort.
 */
export type HostBundleClass = "system" | "app" | "none";

/** Pure classification of the resolved hosting bundle path. */
export function classifyHostBundle(bundle: string | null): HostBundleClass {
	if (!bundle) return "none";
	if (bundle.startsWith("/System/")) return "system";
	return "app";
}

/** Pure fail-closed eligibility table for in-process Speech APIs. */
export function hostClassAllowsInProcessSpeech(hostClass: HostBundleClass, hasUsageKeys: boolean): boolean {
	if (hostClass === "system") return true;
	if (hostClass === "app") return hasUsageKeys;
	return false; // unknown/ambiguous hosts never auto-select in-process Apple
}

/**
 * Fast negative pre-filter: when the ancestry walk finds a third-party
 * bundle that provably lacks the usage descriptions, skip the sacrificial
 * probe entirely — probing there would only crash the probe child and, in
 * the microphone-permission case, flash a doomed prompt. This is an
 * optimization only; the authoritative gate is the probe
 * (`probeInProcessSpeechSafety`), which mechanically exercises the real
 * crash surfaces in a child sharing this process's TCC responsibility.
 */
function hostFastNegative(): boolean {
	if (hostAppCheckCache) return hostAppCheckCache.fastNegative;
	let fastNegative = false;
	try {
		let pid = process.pid;
		let bundle: string | null = null;
		for (let depth = 0; depth < 15 && pid > 1; depth++) {
			const out = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)], { stdout: "pipe" });
			const line = out.stdout.toString().trim();
			if (!line) break;
			const match = line.match(/^(\d+)\s+(.*)$/);
			if (!match) break;
			pid = Number(match[1]);
			bundle = bundlePathFromExecutablePath(match[2] ?? "");
			if (bundle) break;
		}
		if (classifyHostBundle(bundle) === "app" && bundle) {
			const hasUsageKeys = ["NSSpeechRecognitionUsageDescription", "NSMicrophoneUsageDescription"].every(
				key =>
					Bun.spawnSync(["defaults", "read", `${bundle}/Contents/Info`, key], {
						stdout: "ignore",
						stderr: "ignore",
					}).exitCode === 0,
			);
			if (!hasUsageKeys) {
				fastNegative = true;
				logger.warn("Apple speech disabled: hosting terminal app lacks usage descriptions", { bundle });
			}
		}
	} catch {
		fastNegative = false; // unknown — the probe decides
	}
	hostAppCheckCache = { fastNegative };
	return fastNegative;
}

/** Test hook — reset the host-app preflight cache. */
export function resetHostAppSpeechCheckCache(): void {
	hostAppCheckCache = null;
}

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
	reason?: "platform" | "locale" | "assets" | "on-device" | "permission" | "host-app";
	authorization: AppleAuthorization;
}

/**
 * Availability check for the in-process Apple backend.
 *
 * Eligibility is probe-gated, never assumed: after a cheap fast-negative
 * pre-filter, a sacrificial child process exercises the real Speech crash
 * surfaces (see `apple-probe.ts`). Unknown or ambiguous hosts therefore
 * never reach in-process Speech APIs — including via forced
 * `stt.backend=apple`, which uses this same path. May trigger the one-time
 * speech/microphone permission prompts (they are prerequisites for any real
 * session).
 */
export async function appleBackendAvailability(language?: string): Promise<AppleAvailability> {
	if (process.platform !== "darwin") {
		return { usable: false, reason: "platform", authorization: "notDetermined" };
	}
	if (hostFastNegative()) {
		return { usable: false, reason: "host-app", authorization: "notDetermined" };
	}
	const probe = await probeInProcessSpeechSafety();
	if (!probe.safe) {
		const authorization = (macSpeechAuthorizationStatus() ?? "notDetermined") as AppleAuthorization;
		if (probe.reason?.startsWith("permission:")) {
			return { usable: false, reason: "permission", authorization };
		}
		return { usable: false, reason: "host-app", authorization };
	}
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
