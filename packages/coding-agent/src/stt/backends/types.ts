/**
 * Speech-to-text backend contract.
 *
 * Two implementations exist:
 * - `apple` — native on-device `SFSpeechRecognizer` (macOS, streaming
 *   partials + levels, zero setup)
 * - `whisper` — the original record-then-transcribe path (all platforms,
 *   Python + openai-whisper)
 *
 * The controller drives both through this one interface; streaming-only UX
 * (ghost transcript) degrades gracefully when `streaming` is false.
 */

export type SttBackendId = "apple" | "whisper";
export type SttBackendPreference = "auto" | SttBackendId;

export interface SttStartOptions {
	/** Short language code from settings (e.g. "en", "ko") or undefined for system default. */
	language?: string;
	/** Whisper model name (whisper backend only). */
	modelName?: string;
	/** Domain vocabulary to bias recognition (identifiers, file names). */
	vocabulary?: readonly string[];
	/** Streaming partial transcript (apple backend only). */
	onPartial?(text: string): void;
	/** Normalized input level 0..1 for the meter (both backends). */
	onLevel?(level: number): void;
	/** Asynchronous session failure while listening (session is dead). */
	onError?(message: string): void;
	/** Progress messages during dependency setup (whisper backend only). */
	onStatus?(message: string): void;
}

export interface SttSession {
	/** Graceful stop — resolves with the final transcript (may be empty). */
	stop(): Promise<string>;
	/** Hard cancel — discard audio and transcript, suppress further events. */
	cancel(): Promise<void>;
}

export interface SttBackend {
	readonly id: SttBackendId;
	/** Whether the backend delivers streaming partial transcripts. */
	readonly streaming: boolean;
	start(options: SttStartOptions): Promise<SttSession>;
}
