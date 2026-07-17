/**
 * Pure audio-level helpers shared by the STT backends and the TUI meter.
 *
 * Levels are normalized to 0..1 through a -50dBFS..0dBFS RMS window — the
 * same mapping the native Apple backend uses (`crates/pi-natives/src/speech.rs`),
 * so the meter feels identical regardless of backend.
 */

const DB_FLOOR = -50;

/** Sparkline glyphs from silent to loud. */
const SPARK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
/** ASCII fallback for terminals without unicode blocks. */
const SPARK_GLYPHS_ASCII = [".", ".", ":", ":", "|", "|", "#", "#"] as const;

/**
 * RMS level of little-endian PCM16 samples mapped to 0..1.
 * Returns 0 for empty/odd-length input.
 */
export function pcm16RmsLevel(bytes: Uint8Array): number {
	const sampleCount = Math.floor(bytes.length / 2);
	if (sampleCount === 0) return 0;
	const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
	let sum = 0;
	for (let i = 0; i < sampleCount; i++) {
		const sample = view.getInt16(i * 2, true) / 32768;
		sum += sample * sample;
	}
	const rms = Math.sqrt(sum / sampleCount);
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	return Math.min(1, Math.max(0, (db - DB_FLOOR) / -DB_FLOOR));
}

/**
 * Append a level sample to a bounded history (mutates and returns the array).
 */
export function pushLevel(history: number[], level: number, cap = 8): number[] {
	history.push(Math.min(1, Math.max(0, level)));
	while (history.length > cap) history.shift();
	return history;
}

/**
 * Render a fixed-width sparkline for the most recent levels.
 * Missing samples render as silence so the meter width never jumps.
 */
export function renderLevelSparkline(levels: readonly number[], width = 8, unicode = true): string {
	const glyphs = unicode ? SPARK_GLYPHS : SPARK_GLYPHS_ASCII;
	const recent = levels.slice(-width);
	const padded = new Array<number>(Math.max(0, width - recent.length)).fill(0).concat(recent);
	return padded
		.map(level => {
			const index = Math.min(glyphs.length - 1, Math.max(0, Math.floor(level * glyphs.length)));
			return glyphs[index];
		})
		.join("");
}

/**
 * Shape a streaming partial transcript for the single-line ghost overlay:
 * newest words win, so long partials keep their **tail** visible.
 */
export function formatGhostTranscript(text: string, maxChars = 80): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxChars) return collapsed;
	return `…${collapsed.slice(collapsed.length - (maxChars - 1))}`;
}
