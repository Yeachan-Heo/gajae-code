import { describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";
import {
	hasNonUniformImageBytes,
	isAllowedGitReplayCommand,
	parsePngDimensions,
	pngCrc32,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-evidence";

function createPngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeBytes = Buffer.from(type, "ascii");
	const crcData = Buffer.concat([typeBytes, data]);
	const crc = pngCrc32(crcData);
	const crcBytes = Buffer.alloc(4);
	crcBytes.writeUInt32BE(crc, 0);
	return Buffer.concat([length, typeBytes, data, crcBytes]);
}

function createTestPng(width: number, height: number, filterTypes: number[]): Buffer {
	const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	// IHDR chunk: 8-bit RGBA
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type (RGBA)
	ihdr[10] = 0; // compression method
	ihdr[11] = 0; // filter method
	ihdr[12] = 0; // interlace method

	// Create pixel data with variety
	const pixelRows: Buffer[] = [];
	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(width * 4);
		for (let x = 0; x < width; x++) {
			const offset = x * 4;
			// Create varied pixel data to pass uniformity check
			row[offset] = (x + y) % 256; // R
			row[offset + 1] = ((x * 2 + y) % 256) as number; // G
			row[offset + 2] = ((x + y * 2) % 256) as number; // B
			row[offset + 3] = 255; // A
		}
		pixelRows.push(row);
	}

	// Apply filters to create scanlines
	const scanlines = Buffer.alloc(height * (1 + width * 4));
	const decodedRows: Buffer[] = []; // Track decoded pixel data for each row
	let offset = 0;
	for (let y = 0; y < height; y++) {
		const filterType = filterTypes[y % filterTypes.length]!;
		scanlines[offset++] = filterType;

		const pixelRow = pixelRows[y]!;
		const bytesPerPixel = 4;
		const decodedRow = Buffer.alloc(width * 4);
		const priorDecodedRow = decodedRows[y - 1] || Buffer.alloc(width * 4);

		switch (filterType) {
			case 0: // None
				pixelRow.copy(scanlines, offset);
				pixelRow.copy(decodedRow);
				break;
			case 1: // Sub - uses left pixel (same row)
				for (let i = 0; i < width * 4; i++) {
					const left = i < bytesPerPixel ? 0 : decodedRow[i - bytesPerPixel]!;
					const filtered = (pixelRow[i]! - left) & 0xff;
					scanlines[offset + i] = filtered;
					decodedRow[i] = pixelRow[i]!;
				}
				break;
			case 2: // Up - uses above pixel (prior row)
				for (let i = 0; i < width * 4; i++) {
					const above = priorDecodedRow[i]!;
					const filtered = (pixelRow[i]! - above) & 0xff;
					scanlines[offset + i] = filtered;
					decodedRow[i] = pixelRow[i]!;
				}
				break;
			case 3: // Average - uses left and above
				for (let i = 0; i < width * 4; i++) {
					const left = i < bytesPerPixel ? 0 : decodedRow[i - bytesPerPixel]!;
					const above = priorDecodedRow[i]!;
					const average = Math.floor((left + above) / 2);
					const filtered = (pixelRow[i]! - average) & 0xff;
					scanlines[offset + i] = filtered;
					decodedRow[i] = pixelRow[i]!;
				}
				break;
			case 4: // Paeth - uses left, above, and upper-left
				for (let i = 0; i < width * 4; i++) {
					const left = i < bytesPerPixel ? 0 : decodedRow[i - bytesPerPixel]!;
					const above = priorDecodedRow[i]!;
					const upperLeft = i < bytesPerPixel ? 0 : priorDecodedRow[i - bytesPerPixel]!;
					const p = left + above - upperLeft;
					const pa = Math.abs(p - left);
					const pb = Math.abs(p - above);
					const pc = Math.abs(p - upperLeft);
					let predictor: number;
					if (pa <= pb && pa <= pc) predictor = left;
					else if (pb <= pc) predictor = above;
					else predictor = upperLeft;
					const filtered = (pixelRow[i]! - predictor) & 0xff;
					scanlines[offset + i] = filtered;
					decodedRow[i] = pixelRow[i]!;
				}
				break;
		}
		decodedRows[y] = decodedRow;
		offset += width * 4;
	}

	// IDAT chunk
	const compressed = deflateSync(scanlines);

	// Build PNG
	const chunks = [
		PNG_SIGNATURE,
		createPngChunk("IHDR", ihdr),
		createPngChunk("IDAT", compressed),
		createPngChunk("IEND", Buffer.alloc(0)),
	];

	return Buffer.concat(chunks);
}

function createSolidColorPng(width: number, height: number, red: number, green: number, blue: number): Buffer {
	const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	// IHDR chunk: 8-bit RGBA
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type (RGBA)
	ihdr[10] = 0; // compression method
	ihdr[11] = 0; // filter method
	ihdr[12] = 0; // interlace method

	// Create solid color pixel data
	const scanlines = Buffer.alloc(height * (1 + width * 4));
	let offset = 0;
	for (let y = 0; y < height; y++) {
		scanlines[offset++] = 0; // Filter type: None
		for (let x = 0; x < width; x++) {
			const pixelOffset = x * 4;
			scanlines[offset + pixelOffset] = red;
			scanlines[offset + pixelOffset + 1] = green;
			scanlines[offset + pixelOffset + 2] = blue;
			scanlines[offset + pixelOffset + 3] = 255;
		}
		offset += width * 4;
	}

	// IDAT chunk
	const compressed = deflateSync(scanlines);

	// Build PNG
	const chunks = [
		PNG_SIGNATURE,
		createPngChunk("IHDR", ihdr),
		createPngChunk("IDAT", compressed),
		createPngChunk("IEND", Buffer.alloc(0)),
	];

	return Buffer.concat(chunks);
}

describe("ultragoal evidence extraction", () => {
	it("retains the PNG CRC32 implementation", () => {
		expect(pngCrc32(Buffer.from("123456789"))).toBe(0xcbf43926);
	});

	it("retains the conservative git replay allowlist", () => {
		expect(isAllowedGitReplayCommand(["diff", "--stat", "HEAD"])).toBe(true);
		expect(isAllowedGitReplayCommand(["diff", "--output=/tmp/out"])).toBe(false);
	});
});

describe("PNG unfiltering", () => {
	it("parses PNG with filter type 0 (None)", () => {
		const png = createTestPng(32, 32, [0]);
		const result = parsePngDimensions(png);
		expect(result).not.toBeNull();
		expect(result?.width).toBe(32);
		expect(result?.height).toBe(32);
		expect(result?.sampleBytes).toBeDefined();
		expect(result?.sampleBytes?.length).toBe(32 * 32 * 4); // unfiltered pixels
	});

	it("parses PNG with filter type 1 (Sub)", () => {
		const png = createTestPng(32, 32, [1]);
		const result = parsePngDimensions(png);
		expect(result).not.toBeNull();
		expect(result?.width).toBe(32);
		expect(result?.height).toBe(32);
		expect(result?.sampleBytes?.length).toBe(32 * 32 * 4);
	});

	it("parses PNG with filter type 2 (Up)", () => {
		const png = createTestPng(32, 32, [2]);
		const result = parsePngDimensions(png);
		expect(result).not.toBeNull();
		expect(result?.sampleBytes?.length).toBe(32 * 32 * 4);
	});

	it("parses PNG with filter type 3 (Average)", () => {
		const png = createTestPng(32, 32, [3]);
		const result = parsePngDimensions(png);
		expect(result).not.toBeNull();
		expect(result?.sampleBytes?.length).toBe(32 * 32 * 4);
	});

	it("parses PNG with filter type 4 (Paeth)", () => {
		const png = createTestPng(32, 32, [4]);
		const result = parsePngDimensions(png);
		expect(result).not.toBeNull();
		expect(result?.sampleBytes?.length).toBe(32 * 32 * 4);
	});

	it("parses PNG with mixed filter types", () => {
		const png = createTestPng(32, 32, [0, 1, 2, 3, 4]);
		const result = parsePngDimensions(png);
		expect(result).not.toBeNull();
		expect(result?.sampleBytes?.length).toBe(32 * 32 * 4);
	});

	it("rejects PNG with invalid filter type", () => {
		const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(16, 0);
		ihdr.writeUInt32BE(16, 4);
		ihdr[8] = 8;
		ihdr[9] = 6;
		ihdr[10] = 0;
		ihdr[11] = 0;
		ihdr[12] = 0;

		// Create scanline with invalid filter type
		const scanlines = Buffer.alloc(16 * (1 + 16 * 4));
		scanlines[0] = 5; // Invalid filter type
		// Fill rest with zeros
		for (let i = 1; i < scanlines.length; i++) scanlines[i] = 0;

		const compressed = deflateSync(scanlines);
		const chunks = [
			PNG_SIGNATURE,
			createPngChunk("IHDR", ihdr),
			createPngChunk("IDAT", compressed),
			createPngChunk("IEND", Buffer.alloc(0)),
		];
		const png = Buffer.concat(chunks);

		const result = parsePngDimensions(png);
		expect(result).toBeNull();
	});

	it("rejects PNG with decompressed length mismatch", () => {
		const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(16, 0);
		ihdr.writeUInt32BE(16, 4);
		ihdr[8] = 8;
		ihdr[9] = 6;
		ihdr[10] = 0;
		ihdr[11] = 0;
		ihdr[12] = 0;

		// Create truncated scanline (too short)
		const scanlines = Buffer.alloc(10); // Should be 16 * (1 + 16*4) = 1040
		scanlines[0] = 0;

		const compressed = deflateSync(scanlines);
		const chunks = [
			PNG_SIGNATURE,
			createPngChunk("IHDR", ihdr),
			createPngChunk("IDAT", compressed),
			createPngChunk("IEND", Buffer.alloc(0)),
		];
		const png = Buffer.concat(chunks);

		const result = parsePngDimensions(png);
		expect(result).toBeNull();
	});

	it("byte-exact pixel reconstruction for all filter types", () => {
		const png0 = createTestPng(32, 16, [0]);
		const png1 = createTestPng(32, 16, [1]);
		const png2 = createTestPng(32, 16, [2]);
		const png3 = createTestPng(32, 16, [3]);
		const png4 = createTestPng(32, 16, [4]);

		const result0 = parsePngDimensions(png0);
		const result1 = parsePngDimensions(png1);
		const result2 = parsePngDimensions(png2);
		const result3 = parsePngDimensions(png3);
		const result4 = parsePngDimensions(png4);

		expect(result0?.sampleBytes).toBeDefined();
		expect(result1?.sampleBytes).toBeDefined();
		expect(result2?.sampleBytes).toBeDefined();
		expect(result3?.sampleBytes).toBeDefined();
		expect(result4?.sampleBytes).toBeDefined();

		// All filters encoding the same pixel data must reconstruct identically
		if (
			result0?.sampleBytes &&
			result1?.sampleBytes &&
			result2?.sampleBytes &&
			result3?.sampleBytes &&
			result4?.sampleBytes
		) {
			expect(result1.sampleBytes).toEqual(result0.sampleBytes);
			expect(result2.sampleBytes).toEqual(result0.sampleBytes);
			expect(result3.sampleBytes).toEqual(result0.sampleBytes);
			expect(result4.sampleBytes).toEqual(result0.sampleBytes);
		}
	});

	it("byte-exact reconstruction with mixed filter types", () => {
		const pngMixed = createTestPng(32, 16, [0, 1, 2, 3, 4]);
		const pngNone = createTestPng(32, 16, [0]);

		const resultMixed = parsePngDimensions(pngMixed);
		const resultNone = parsePngDimensions(pngNone);

		expect(resultMixed?.sampleBytes).toBeDefined();
		expect(resultNone?.sampleBytes).toBeDefined();

		// Mixed filters on same pixel data must reconstruct identically to None
		if (resultMixed?.sampleBytes && resultNone?.sampleBytes) {
			expect(resultMixed.sampleBytes).toEqual(resultNone.sampleBytes);
		}
	});

	it("parses solid-color PNG without error", () => {
		const png = createSolidColorPng(100, 100, 128, 128, 128);
		const result = parsePngDimensions(png);
		expect(result).not.toBeNull();
		expect(result?.width).toBe(100);
		expect(result?.height).toBe(100);
		expect(result?.sampleBytes?.length).toBe(100 * 100 * 4);
	});

	it("mostly-white image with colored content passes through all filters", () => {
		// Create a 320x180 mostly-white image with a small colored content area
		// This tests the regression: mostly-white with real content should pass
		const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

		const width = 320;
		const height = 180;
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(width, 0);
		ihdr.writeUInt32BE(height, 4);
		ihdr[8] = 8;
		ihdr[9] = 6;
		ihdr[10] = 0;
		ihdr[11] = 0;
		ihdr[12] = 0;

		for (const filterType of [0, 1, 2, 3, 4]) {
			const scanlines = Buffer.alloc(height * (1 + width * 4));
			let offset = 0;

			for (let y = 0; y < height; y++) {
				scanlines[offset++] = filterType;
				for (let x = 0; x < width; x++) {
					const pixelOffset = x * 4;
					// Mostly white (250,250,250) with colored rectangle (50-150px, 25-75px)
					let r = 250;
					let g = 250;
					let b = 250;
					if (y >= 25 && y < 75 && x >= 50 && x < 150) {
						// Colored content rectangle
						r = (x + y) & 0xff;
						g = ((x * 2 + y) % 256) as number;
						b = ((x + y * 2) % 256) as number;
					}
					scanlines[offset + pixelOffset] = r;
					scanlines[offset + pixelOffset + 1] = g;
					scanlines[offset + pixelOffset + 2] = b;
					scanlines[offset + pixelOffset + 3] = 255;
				}
				offset += width * 4;
			}

			const compressed = deflateSync(scanlines);
			const chunks = [
				PNG_SIGNATURE,
				createPngChunk("IHDR", ihdr),
				createPngChunk("IDAT", compressed),
				createPngChunk("IEND", Buffer.alloc(0)),
			];
			const png = Buffer.concat(chunks);

			const result = parsePngDimensions(png);
			expect(result).not.toBeNull();
			if (result?.sampleBytes) {
				// Should pass uniformity check because it has varied content
				const isUniform = hasNonUniformImageBytes(png, result.headerBytes, result.sampleBytes);
				expect(isUniform).toBe(true);
			}
		}
	});
});

describe("Uniformity check with decoded pixels", () => {
	it("solid-color image fails uniformity check", () => {
		const png = createSolidColorPng(320, 180, 255, 255, 255);
		const result = parsePngDimensions(png);
		expect(result).not.toBeNull();
		if (result?.sampleBytes) {
			// Solid white should fail the uniformity check
			const isUniform = hasNonUniformImageBytes(png, result.headerBytes, result.sampleBytes);
			expect(isUniform).toBe(false);
		}
	});

	it("varied-pixel image passes uniformity check", () => {
		const png = createTestPng(320, 180, [0]);
		const result = parsePngDimensions(png);
		expect(result).not.toBeNull();
		if (result?.sampleBytes) {
			// Varied pixels should pass the uniformity check
			const isUniform = hasNonUniformImageBytes(png, result.headerBytes, result.sampleBytes);
			expect(isUniform).toBe(true);
		}
	});

	it("filter invariance: same pixels with different filters produce same uniformity result", () => {
		const png0 = createTestPng(320, 180, [0]); // None filter
		const png1 = createTestPng(320, 180, [1]); // Sub filter
		const png2 = createTestPng(320, 180, [2]); // Up filter
		const png3 = createTestPng(320, 180, [3]); // Average filter
		const png4 = createTestPng(320, 180, [4]); // Paeth filter

		const result0 = parsePngDimensions(png0);
		const result1 = parsePngDimensions(png1);
		const result2 = parsePngDimensions(png2);
		const result3 = parsePngDimensions(png3);
		const result4 = parsePngDimensions(png4);

		expect(result0).not.toBeNull();
		expect(result1).not.toBeNull();
		expect(result2).not.toBeNull();
		expect(result3).not.toBeNull();
		expect(result4).not.toBeNull();

		if (
			result0?.sampleBytes &&
			result1?.sampleBytes &&
			result2?.sampleBytes &&
			result3?.sampleBytes &&
			result4?.sampleBytes
		) {
			const uniform0 = hasNonUniformImageBytes(png0, result0.headerBytes, result0.sampleBytes);
			const uniform1 = hasNonUniformImageBytes(png1, result1.headerBytes, result1.sampleBytes);
			const uniform2 = hasNonUniformImageBytes(png2, result2.headerBytes, result2.sampleBytes);
			const uniform3 = hasNonUniformImageBytes(png3, result3.headerBytes, result3.sampleBytes);
			const uniform4 = hasNonUniformImageBytes(png4, result4.headerBytes, result4.sampleBytes);

			// All should have the same result since they have the same pixel data
			expect(uniform0).toBe(uniform1);
			expect(uniform1).toBe(uniform2);
			expect(uniform2).toBe(uniform3);
			expect(uniform3).toBe(uniform4);
			// And all should pass (have varied content)
			expect(uniform0).toBe(true);
		}
	});
});
