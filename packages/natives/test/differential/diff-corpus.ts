import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

export const DIFF_MUTATION_SEEDS = [1, 17, 0xc0fff0] as const;

export interface DiffFixtureFile {
	name: string;
	text: string;
}

export interface DiffFixtureCorpus {
	archiveSha256: string;
	files: DiffFixtureFile[];
}

export async function loadDiffFixtureCorpus(): Promise<DiffFixtureCorpus> {
	const archivePath = path.resolve(import.meta.dir, "../../../../packages/typescript-edit-benchmark/fixtures.tar.gz");
	const archive = new Uint8Array(await fs.readFile(archivePath));
	const tar = gunzipSync(archive);
	const decoder = new TextDecoder();
	const files: DiffFixtureFile[] = [];
	let offset = 0;

	while (offset + 512 <= tar.byteLength) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) break;

		const readField = (start: number, length: number) => {
			const end = header.subarray(start, start + length).indexOf(0);
			return decoder.decode(header.subarray(start, end === -1 ? start + length : start + end));
		};
		const name = readField(0, 100);
		const prefix = readField(345, 155);
		const fullName = prefix ? `${prefix}/${name}` : name;
		const sizeField = readField(124, 12).trim();
		const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
		const type = header[156];
		const contentStart = offset + 512;
		const contentEnd = contentStart + size;
		if (!Number.isSafeInteger(size) || size < 0 || contentEnd > tar.byteLength) {
			throw new Error(`Invalid tar member size for ${fullName}`);
		}

		if (fullName.startsWith("fixtures/") && (type === 0 || type === 48) && size > 0) {
			files.push({ name: fullName, text: decoder.decode(tar.subarray(contentStart, contentEnd)) });
		}
		offset = contentStart + Math.ceil(size / 512) * 512;
	}

	files.sort((a, b) => a.name.localeCompare(b.name));
	if (files.length === 0) throw new Error("No regular fixture files were found in fixtures.tar.gz");
	return { archiveSha256: createHash("sha256").update(archive).digest("hex"), files };
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
	};
}

export function seededDiffMutation(text: string, seed: number): string {
	const random = seededRandom(seed);
	const offset = Math.floor(random() * (text.length + 1));
	const end = Math.min(text.length, offset + 1 + Math.floor(random() * 8));
	const marker = [`seed-${seed}`, "gjc-Δ", "🚀", "\r\n"][Math.floor(random() * 4)]!;
	const mode = seed % 3;
	const mutation =
		mode === 0
			? `${text.slice(0, offset)}${marker}${text.slice(offset)}`
			: mode === 1
				? `${text.slice(0, offset)}${marker}${text.slice(end)}`
				: `${text.slice(0, offset)}${text.slice(end)}`;
	return mutation === text ? `${text}${marker}` : mutation;
}
