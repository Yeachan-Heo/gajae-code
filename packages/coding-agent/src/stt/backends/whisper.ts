/**
 * Whisper speech backend — the original record-then-transcribe path,
 * reshaped to the `SttBackend` contract and upgraded with:
 * - live input levels read from the growing WAV file (no new dependencies)
 * - vocabulary bias via whisper `initial_prompt`
 *
 * No behavior change to recording or transcription itself.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, Snowflake } from "@gajae-code/utils";
import { ensureSTTDependencies } from "../downloader";
import { pcm16RmsLevel } from "../level-meter";
import { type RecordingHandle, startRecording, verifyRecordingFile } from "../recorder";
import { transcribe } from "../transcriber";
import { vocabularyToWhisperPrompt } from "../vocabulary";
import type { SttBackend, SttSession, SttStartOptions } from "./types";

/** WAV header size — tail reads never dip below this offset. */
const WAV_HEADER_BYTES = 44;
/** Cadence of level meter samples read from the growing WAV file. */
const LEVEL_POLL_INTERVAL_MS = 100;
/** Tail window per level sample (~0.25s of 16kHz mono PCM16). */
const LEVEL_TAIL_BYTES = 8_192;

let depsResolved = false;

/**
 * Read the newest PCM16 samples from a growing WAV file and map them to a
 * 0..1 meter level. Fails soft to `undefined` (recorder may not have
 * flushed yet, or the tool may write a non-PCM16 container).
 */
export async function readWavTailLevel(filePath: string): Promise<number | undefined> {
	try {
		const stat = await fs.stat(filePath);
		if (stat.size <= WAV_HEADER_BYTES + 2) return undefined;
		const end = stat.size;
		let start = Math.max(WAV_HEADER_BYTES, end - LEVEL_TAIL_BYTES);
		// Keep 16-bit sample alignment relative to the data chunk.
		if ((end - start) % 2 === 1) start += 1;
		const handle = await fs.open(filePath, "r");
		try {
			const length = end - start;
			const buffer = new Uint8Array(length);
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			if (bytesRead <= 0) return undefined;
			return pcm16RmsLevel(buffer.subarray(0, bytesRead));
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

class WhisperSession implements SttSession {
	#recording: RecordingHandle;
	#tempFile: string;
	#options: SttStartOptions;
	#levelTimer: ReturnType<typeof setInterval> | undefined;
	#abort = new AbortController();
	#done = false;

	constructor(recording: RecordingHandle, tempFile: string, options: SttStartOptions) {
		this.#recording = recording;
		this.#tempFile = tempFile;
		this.#options = options;
		if (options.onLevel) {
			this.#levelTimer = setInterval(() => {
				void readWavTailLevel(this.#tempFile).then(level => {
					if (level !== undefined && !this.#done) this.#options.onLevel?.(level);
				});
			}, LEVEL_POLL_INTERVAL_MS);
		}
	}

	#teardownMeter(): void {
		if (this.#levelTimer) {
			clearInterval(this.#levelTimer);
			this.#levelTimer = undefined;
		}
	}

	async #removeTempFile(): Promise<void> {
		try {
			await fs.rm(this.#tempFile, { force: true });
		} catch {
			// best effort cleanup
		}
	}

	async stop(): Promise<string> {
		this.#done = true;
		this.#teardownMeter();
		try {
			await this.#recording.stop();
			await verifyRecordingFile(this.#tempFile);
			const prompt = vocabularyToWhisperPrompt(this.#options.vocabulary ?? []);
			return await transcribe(this.#tempFile, {
				modelName: this.#options.modelName,
				language: this.#options.language,
				initialPrompt: prompt || undefined,
				signal: this.#abort.signal,
			});
		} finally {
			await this.#removeTempFile();
		}
	}

	async cancel(): Promise<void> {
		this.#done = true;
		this.#teardownMeter();
		this.#abort.abort();
		await this.#recording.stop().catch(() => {});
		await this.#removeTempFile();
	}
}

export class WhisperSttBackend implements SttBackend {
	readonly id = "whisper" as const;
	readonly streaming = false;

	async start(options: SttStartOptions): Promise<SttSession> {
		if (!depsResolved) {
			options.onStatus?.("Checking STT dependencies...");
			await ensureSTTDependencies({
				modelName: options.modelName,
				onProgress: p => options.onStatus?.(p.stage + (p.percent != null ? ` (${p.percent}%)` : "")),
			});
			options.onStatus?.("");
			depsResolved = true;
		}
		const tempFile = path.join(os.tmpdir(), `gjc-stt-${Snowflake.next()}.wav`);
		const recording = await startRecording(tempFile);
		logger.debug("STT recording started", { tempFile, backend: "whisper" });
		return new WhisperSession(recording, tempFile, options);
	}
}

/** Test hook — reset the module-level dependency cache. */
export function resetWhisperDependencyCache(): void {
	depsResolved = false;
}
