import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readWavTailLevel } from "../src/stt/backends/whisper";

const tempFiles: string[] = [];

async function writeWav(samples: number[]): Promise<string> {
	const file = path.join(os.tmpdir(), `gjc-stt-test-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
	tempFiles.push(file);
	// Minimal PCM16 mono 16kHz WAV header (44 bytes) + samples.
	const dataSize = samples.length * 2;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, 16_000, true);
	view.setUint32(28, 32_000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, "data");
	view.setUint32(40, dataSize, true);
	samples.forEach((sample, i) => {
		view.setInt16(44 + i * 2, sample, true);
	});
	await fs.writeFile(file, new Uint8Array(buffer));
	return file;
}

afterAll(async () => {
	await Promise.all(tempFiles.map(file => fs.rm(file, { force: true }).catch(() => {})));
});

describe("readWavTailLevel", () => {
	test("returns a positive level for a loud tail", async () => {
		const samples = Array.from({ length: 4_000 }, (_, i) => (i % 2 === 0 ? 20_000 : -20_000));
		const file = await writeWav(samples);
		const level = await readWavTailLevel(file);
		expect(level).toBeGreaterThan(0.5);
	});

	test("returns ~0 for silence", async () => {
		const file = await writeWav(new Array(4_000).fill(0));
		const level = await readWavTailLevel(file);
		expect(level).toBe(0);
	});

	test("fails soft on missing or header-only files", async () => {
		expect(await readWavTailLevel("/nonexistent/file.wav")).toBeUndefined();
		const file = await writeWav([]);
		expect(await readWavTailLevel(file)).toBeUndefined();
	});
});
