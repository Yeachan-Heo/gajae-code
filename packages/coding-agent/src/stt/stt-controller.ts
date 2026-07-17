import { logger } from "@gajae-code/utils";
import { settings } from "../config/settings";
import { resolveSttBackend, type SttBackendId, type SttBackendPreference, type SttSession } from "./backends";
import { formatGhostTranscript } from "./level-meter";
import { collectRepoVocabulary } from "./vocabulary";

export type SttState = "idle" | "recording" | "transcribing";

/** All-zero input for this long while recording triggers the dead-mic hint. */
const SILENT_INPUT_HINT_AFTER_MS = 3_000;
export const SILENT_INPUT_HINT =
	"No microphone signal — your terminal may lack microphone permission (System Settings → Privacy & Security → Microphone).";

interface ToggleOptions {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: SttState): void;
	/** Streaming ghost transcript; `null` clears the overlay. */
	onPartial?(text: string | null): void;
	/** Normalized input level 0..1 for the meter. */
	onLevel?(level: number): void;
	/** Repository root used for vocabulary collection. */
	cwd?: string;
}

interface Editor {
	insertText(text: string): void;
}

export class STTController {
	#state: SttState = "idle";
	#session: SttSession | null = null;
	#backendId: SttBackendId | null = null;
	#toggling = false;
	#disposed = false;
	/** Guards late async events after cancel/dispose. */
	#generation = 0;
	#listeningStartedAt = 0;
	#sawInputSignal = false;
	#silentHintShown = false;

	get state(): SttState {
		return this.#state;
	}

	get backendId(): SttBackendId | null {
		return this.#backendId;
	}

	#setState(state: SttState, options: ToggleOptions): void {
		this.#state = state;
		options.onStateChange(state);
	}

	async toggle(editor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#toggling) return;
		this.#toggling = true;
		try {
			switch (this.#state) {
				case "idle":
					await this.#startListening(options);
					break;
				case "recording":
					await this.#stopAndInsert(editor, options);
					break;
				case "transcribing":
					options.showStatus("Transcription in progress...");
					break;
			}
		} finally {
			this.#toggling = false;
		}
	}

	/**
	 * Cancel the active voice session (Esc). Returns true when there was an
	 * active session to cancel — callers use this to decide whether the key
	 * press was consumed.
	 */
	cancel(options: ToggleOptions): boolean {
		if (this.#state === "idle" || !this.#session) return false;
		this.#generation += 1;
		const session = this.#session;
		this.#session = null;
		void session.cancel().catch(() => {});
		options.onPartial?.(null);
		this.#setState("idle", options);
		options.showStatus("Voice input cancelled.");
		logger.debug("STT session cancelled", { backend: this.#backendId });
		return true;
	}

	async #startListening(options: ToggleOptions): Promise<void> {
		const generation = ++this.#generation;
		try {
			const preference = (settings.get("stt.backend") as SttBackendPreference | undefined) ?? "auto";
			const language = settings.get("stt.language") as string | undefined;
			const { backend, fallbackNote } = await resolveSttBackend(preference, language);
			if (fallbackNote) options.showStatus(fallbackNote);
			this.#backendId = backend.id;

			// Vocabulary is best-effort and bounded; never block listening on it.
			const vocabulary = options.cwd ? await collectRepoVocabulary(options.cwd) : [];

			const session = await backend.start({
				language,
				modelName: settings.get("stt.modelName") as string | undefined,
				vocabulary,
				onStatus: msg => {
					if (generation === this.#generation) options.showStatus(msg);
				},
				onPartial: text => {
					if (generation === this.#generation && this.#state === "recording") {
						options.onPartial?.(formatGhostTranscript(text));
					}
				},
				onLevel: level => {
					if (generation === this.#generation && this.#state === "recording") {
						if (level > 0) this.#sawInputSignal = true;
						else if (
							!this.#sawInputSignal &&
							!this.#silentHintShown &&
							Date.now() - this.#listeningStartedAt >= SILENT_INPUT_HINT_AFTER_MS
						) {
							this.#silentHintShown = true;
							options.showStatus(SILENT_INPUT_HINT);
						}
						options.onLevel?.(level);
					}
				},
				onError: message => {
					if (generation !== this.#generation) return;
					this.#session = null;
					options.onPartial?.(null);
					this.#setState("idle", options);
					options.showWarning(message);
				},
			});
			if (this.#disposed || generation !== this.#generation) {
				void session.cancel().catch(() => {});
				return;
			}
			this.#session = session;
			this.#listeningStartedAt = Date.now();
			this.#sawInputSignal = false;
			this.#silentHintShown = false;
			this.#setState("recording", options);
			logger.debug("STT listening", { backend: backend.id });
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to start voice input";
			options.showWarning(msg);
			logger.error("STT session failed to start", { error: msg });
		}
	}

	async #stopAndInsert(editor: Editor, options: ToggleOptions): Promise<void> {
		const session = this.#session;
		this.#session = null;
		if (!session) {
			this.#setState("idle", options);
			return;
		}
		const generation = this.#generation;
		this.#setState("transcribing", options);
		try {
			const text = (await session.stop()).trim();
			if (this.#disposed || generation !== this.#generation) return;
			options.onPartial?.(null);
			if (text.length > 0) {
				editor.insertText(text);
				options.showStatus("");
			} else {
				options.showStatus("No speech detected.");
			}
		} catch (err) {
			if (this.#disposed || generation !== this.#generation) return;
			options.onPartial?.(null);
			if (err instanceof DOMException && err.name === "AbortError") {
				this.#setState("idle", options);
				return;
			}
			const msg = err instanceof Error ? err.message : "Transcription failed";
			options.showWarning(msg);
			logger.error("STT transcription failed", { error: msg });
		} finally {
			if (!this.#disposed && generation === this.#generation) this.#setState("idle", options);
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#generation += 1;
		if (this.#session) {
			void this.#session.cancel().catch(() => {});
			this.#session = null;
		}
		this.#state = "idle";
	}
}
