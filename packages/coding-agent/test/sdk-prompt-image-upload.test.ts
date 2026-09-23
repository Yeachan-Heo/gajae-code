import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { PromptImageUploadStore } from "../src/sdk/host/prompt-image-upload";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
	const name = Buffer.from(type, "ascii");
	const crcInput = Buffer.concat([name, data]);
	let crc = 0xffffffff;
	for (const byte of crcInput) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
	return Buffer.concat([length, name, data, checksum]);
}

/** Uncompressed scanlines with varied RGB pixels: the encoded image itself exceeds one SDK frame. */
function originalLargePng(seed = 0x12345678): Buffer {
	const width = 400;
	const height = 300;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const pixels = Buffer.alloc(height * (1 + width * 3));
	let state = seed;
	for (let row = 0; row < height; row++) {
		const offset = row * (1 + width * 3);
		pixels[offset] = 0;
		for (let column = 1; column <= width * 3; column++) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			pixels[offset + column] = state & 255;
		}
	}
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(pixels)),
		pngChunk("IEND"),
	]);
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const descriptor = (bytes: Buffer) => ({ mimeType: "image/png", byteLength: bytes.length, sha256: digest(bytes) });

async function stage(store: PromptImageUploadStore, owner: string, bytes: Buffer): Promise<string> {
	const { id } = store.begin(owner, descriptor(bytes));
	let sequence = 0;
	for (let offset = 0; offset < bytes.length; offset += 96 * 1024) {
		const chunk = bytes.subarray(offset, offset + 96 * 1024);
		expect(store.append(owner, { id, sequence, data: chunk.toString("base64") })).toEqual({
			id,
			nextSequence: ++sequence,
			receivedBytes: offset + chunk.length,
		});
	}
	await store.finish(owner, { id });
	return id;
}

test("a valid original image larger than 256 KiB survives chunk upload and host redemption byte for byte", async () => {
	const bytes = originalLargePng();
	expect(bytes.length).toBeGreaterThan(256 * 1024);
	const store = new PromptImageUploadStore();
	try {
		const id = await stage(store, "sender", bytes);
		const accepted = store.redeem("sender", [{ id }]);
		try {
			expect(accepted.images).toHaveLength(1);
			expect(accepted.images[0]?.mimeType).toBe("image/png");
			expect(Buffer.from(accepted.images[0]!.data, "base64").toString("hex")).toBe(bytes.toString("hex"));
			expect(() => store.redeem("sender", [{ id }])).toThrow(expect.objectContaining({ code: "resource_gone" }));
		} finally {
			accepted.release();
		}
	} finally {
		store.close();
	}
});

test("upload chunks reject out-of-order, duplicate, noncanonical, cross-connection and bad-digest inputs", async () => {
	const bytes = originalLargePng();
	const store = new PromptImageUploadStore();
	try {
		const { id } = store.begin("sender", descriptor(bytes));
		const chunk = bytes.subarray(0, 96 * 1024).toString("base64");
		expect(() => store.append("sender", { id, sequence: 1, data: chunk })).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		expect(() => store.append("other", { id, sequence: 0, data: chunk })).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		expect(() => store.append("sender", { id, sequence: 0, data: `${chunk}\n` })).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		store.append("sender", { id, sequence: 0, data: chunk });
		expect(() => store.append("sender", { id, sequence: 0, data: chunk })).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		await expect(store.finish("sender", { id })).rejects.toMatchObject({ code: "invalid_input" });
		for (let offset = 96 * 1024, sequence = 1; offset < bytes.length; offset += 96 * 1024, sequence++)
			store.append("sender", { id, sequence, data: bytes.subarray(offset, offset + 96 * 1024).toString("base64") });
		await expect(store.finish("other", { id })).rejects.toMatchObject({ code: "resource_gone" });
		await store.finish("sender", { id });
		expect(() =>
			store.append("sender", { id, sequence: Math.ceil(bytes.length / (96 * 1024)), data: chunk }),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));

		const wrong = store.begin("sender", { ...descriptor(bytes), sha256: "0".repeat(64) });
		for (let offset = 0, sequence = 0; offset < bytes.length; offset += 96 * 1024, sequence++)
			store.append("sender", {
				id: wrong.id,
				sequence,
				data: bytes.subarray(offset, offset + 96 * 1024).toString("base64"),
			});
		await expect(store.finish("sender", { id: wrong.id })).rejects.toMatchObject({ code: "invalid_input" });
		expect(() => store.redeem("sender", [{ id: wrong.id }])).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
	} finally {
		store.close();
	}
});

test("redemption is atomic, ordered and connection-owned; discard, disconnect and close expire leases", async () => {
	const bytes = originalLargePng();
	const other = originalLargePng(0x87654321);
	const store = new PromptImageUploadStore();
	try {
		const first = await stage(store, "sender", bytes);
		const second = await stage(store, "sender", other);
		expect(() => store.redeem("other", [{ id: first }])).toThrow(expect.objectContaining({ code: "resource_gone" }));
		expect(() => store.redeem("sender", [{ id: first }, { id: first }])).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		expect(() => store.redeem("sender", [{ id: first }, { id: "missing" }])).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		const accepted = store.redeem("sender", [{ id: second }, { id: first }]);
		try {
			expect(accepted.images.map(image => Buffer.from(image.data, "base64").toString("hex"))).toEqual([
				other.toString("hex"),
				bytes.toString("hex"),
			]);
		} finally {
			accepted.release();
		}
		for (const id of [first, second])
			expect(() => store.redeem("sender", [{ id }])).toThrow(expect.objectContaining({ code: "resource_gone" }));
		const discarded = store.begin("sender", descriptor(bytes));
		expect(store.discard("sender", { id: discarded.id })).toEqual({ discarded: true });
		expect(() => store.append("sender", { id: discarded.id, sequence: 0, data: bytes.toString("base64") })).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		const disconnected = store.begin("sender", descriptor(bytes));
		store.disconnect("sender");
		expect(() => store.redeem("sender", [{ id: disconnected.id }])).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		const closed = store.begin("sender", descriptor(bytes));
		store.close();
		await expect(store.finish("sender", { id: closed.id })).rejects.toMatchObject({ code: "resource_gone" });
	} finally {
		store.close();
	}
});

test("pending uploads enforce the 64 MiB session budget and recover capacity on discard and disconnect", () => {
	const store = new PromptImageUploadStore();
	const capacity = 64 * 1024 * 1024;
	const imageLength = capacity / 4;
	const chunk = Buffer.alloc(96 * 1024).toString("base64");
	const tail = Buffer.alloc(64 * 1024).toString("base64");
	const ids: string[] = [];
	try {
		for (let image = 0; image < 4; image++) {
			const { id } = store.begin("sender", {
				mimeType: "image/png",
				byteLength: imageLength,
				sha256: "0".repeat(64),
			});
			ids.push(id);
			for (let sequence = 0; sequence < 170; sequence++) store.append("sender", { id, sequence, data: chunk });
			store.append("sender", { id, sequence: 170, data: tail });
		}
		const next = store.begin("sender", { mimeType: "image/png", byteLength: 1, sha256: "0".repeat(64) });
		expect(() => store.append("sender", { id: next.id, sequence: 0, data: "AA==" })).toThrow(
			expect.objectContaining({ code: "busy" }),
		);
		expect(store.discard("sender", { id: ids[0] })).toEqual({ discarded: true });
		expect(store.append("sender", { id: next.id, sequence: 0, data: "AA==" })).toMatchObject({ receivedBytes: 1 });
		store.disconnect("sender");
		const resumed = store.begin("sender", { mimeType: "image/png", byteLength: 1, sha256: "0".repeat(64) });
		expect(store.append("sender", { id: resumed.id, sequence: 0, data: "AA==" })).toMatchObject({ receivedBytes: 1 });
	} finally {
		store.close();
	}
});

test("accepted images enforce the 64 MiB session budget until their terminal release", async () => {
	const original = originalLargePng();
	// A safe-to-copy ancillary chunk enlarges the source without changing decoded pixels.
	const image = Buffer.concat([
		original.subarray(0, -12),
		pngChunk("ruSt", Buffer.alloc(17 * 1024 * 1024)),
		original.subarray(-12),
	]);
	const store = new PromptImageUploadStore();
	const releases: Array<() => void> = [];
	try {
		for (let index = 0; index < 3; index++) {
			const id = await stage(store, "sender", image);
			releases.push(store.redeem("sender", [{ id }]).release);
		}
		const pending = await stage(store, "sender", image);
		expect(() => store.redeem("sender", [{ id: pending }])).toThrow(expect.objectContaining({ code: "busy" }));
		releases[0]!();
		const recovered = store.redeem("sender", [{ id: pending }]);
		expect(Buffer.from(recovered.images[0]!.data, "base64").equals(image)).toBe(true);
		releases.push(recovered.release);
		releases[0]!();
	} finally {
		for (const release of releases) release();
		store.close();
	}
}, 60_000);
