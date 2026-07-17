/**
 * STT backend selection.
 *
 * `stt.backend` setting:
 * - `auto` (default) — Apple on-device backend when the platform, locale,
 *   assets, and permission all line up; whisper otherwise. Permission is
 *   requested once on first use.
 * - `apple` — force the native backend; fails loud when unusable.
 * - `whisper` — force the original Python path.
 */

import {
	AppleSttBackend,
	appleBackendAvailability,
	appleRuntimeDegradedReason,
	ensureAppleAuthorization,
} from "./apple";
import type { SttBackend, SttBackendPreference } from "./types";
import { WhisperSttBackend } from "./whisper";

export interface ResolvedSttBackend {
	backend: SttBackend;
	/** One-line, user-facing note when auto-selection fell back to whisper. */
	fallbackNote?: string;
}

const FALLBACK_NOTES: Record<string, string> = {
	locale: "Apple speech does not support this language — using whisper.",
	assets: "Apple speech assets are unavailable — using whisper.",
	"on-device": "Apple speech has no on-device model for this language — using whisper.",
	permission: "Speech recognition permission is denied — using whisper.",
};

export async function resolveSttBackend(
	preference: SttBackendPreference,
	language?: string,
): Promise<ResolvedSttBackend> {
	if (preference === "whisper") return { backend: new WhisperSttBackend() };

	const availability = appleBackendAvailability(language);
	if (preference === "apple") {
		if (!availability.usable) {
			throw new Error(
				availability.reason === "platform"
					? "The Apple speech backend requires macOS."
					: (FALLBACK_NOTES[availability.reason ?? ""] ?? "The Apple speech backend is unavailable.").replace(
							" — using whisper.",
							".",
						),
			);
		}
		return { backend: new AppleSttBackend() };
	}

	// auto
	if (appleRuntimeDegradedReason() !== null) {
		return {
			backend: new WhisperSttBackend(),
			fallbackNote: "Apple speech failed earlier in this session — using whisper.",
		};
	}
	if (!availability.usable) {
		return {
			backend: new WhisperSttBackend(),
			fallbackNote: availability.reason === "platform" ? undefined : FALLBACK_NOTES[availability.reason ?? ""],
		};
	}
	if (availability.authorization === "notDetermined") {
		const resolved = await ensureAppleAuthorization();
		if (resolved !== "authorized") {
			return { backend: new WhisperSttBackend(), fallbackNote: FALLBACK_NOTES.permission };
		}
	}
	return { backend: new AppleSttBackend() };
}

export type { SttBackend, SttBackendId, SttBackendPreference, SttSession, SttStartOptions } from "./types";
