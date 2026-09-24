import { expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { PromptImageUploadStore } from "../src/sdk/host/prompt-image-upload";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Standalone tests deliberately allow synthetic owners; hosts bind this to live sockets.
const alwaysConnected = (_owner: string): boolean => true;

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

function upload(store: PromptImageUploadStore, owner: string, bytes: Buffer): string {
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
	return id;
}

async function stage(store: PromptImageUploadStore, owner: string, bytes: Buffer): Promise<string> {
	const id = upload(store, owner, bytes);
	await store.finish(owner, { id });
	return id;
}

test("a valid original image larger than 256 KiB survives chunk upload and host redemption byte for byte", async () => {
	const bytes = originalLargePng();
	expect(bytes.length).toBeGreaterThan(256 * 1024);
	const store = new PromptImageUploadStore(alwaysConnected);
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

test("concurrent finishes validate one lease only once and reject appends during finalization", async () => {
	const bytes = originalLargePng();
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const { id } = store.begin("sender", descriptor(bytes));
		for (let offset = 0, sequence = 0; offset < bytes.length; offset += 96 * 1024, sequence++)
			store.append("sender", {
				id,
				sequence,
				data: bytes.subarray(offset, offset + 96 * 1024).toString("base64"),
			});
		const attempts = Array.from({ length: 8 }, () => store.finish("sender", { id }));
		const settled = Promise.allSettled(attempts);
		expect(() => store.append("sender", { id, sequence: 4, data: "AA==" })).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		const outcomes = await settled;
		expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
		for (const outcome of outcomes)
			if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "invalid_input" });
		const accepted = store.redeem("sender", [{ id }]);
		try {
			expect(Buffer.from(accepted.images[0]!.data, "base64").equals(bytes)).toBe(true);
		} finally {
			accepted.release();
		}
	} finally {
		store.close();
	}
});

test("distinct sessions share one process-wide decode slot and recover it after finalization", async () => {
	const bytes = originalLargePng();
	const firstStore = new PromptImageUploadStore(alwaysConnected);
	const secondStore = new PromptImageUploadStore(alwaysConnected);
	try {
		const first = upload(firstStore, "sender", bytes);
		const second = upload(secondStore, "sender", bytes);
		const finishing = firstStore.finish("sender", { id: first });
		const competing = secondStore.finish("sender", { id: second });
		await expect(competing).rejects.toMatchObject({ code: "busy" });
		await finishing;
		await secondStore.finish("sender", { id: second });
		const firstAccepted = firstStore.redeem("sender", [{ id: first }]);
		const secondAccepted = secondStore.redeem("sender", [{ id: second }]);
		try {
			expect(Buffer.from(firstAccepted.images[0]!.data, "base64").equals(bytes)).toBe(true);
			expect(Buffer.from(secondAccepted.images[0]!.data, "base64").equals(bytes)).toBe(true);
		} finally {
			firstAccepted.release();
			secondAccepted.release();
		}
	} finally {
		firstStore.close();
		secondStore.close();
	}
});

test("discard during decoding retains the shared slot until its in-flight finish settles", async () => {
	const bytes = originalLargePng();
	const firstStore = new PromptImageUploadStore(alwaysConnected);
	const secondStore = new PromptImageUploadStore(alwaysConnected);
	try {
		const first = upload(firstStore, "sender", bytes);
		const second = upload(secondStore, "sender", bytes);
		const finishing = firstStore.finish("sender", { id: first });
		firstStore.discard("sender", { id: first });
		const competing = secondStore.finish("sender", { id: second });
		await expect(competing).rejects.toMatchObject({ code: "busy" });
		await expect(finishing).rejects.toMatchObject({ code: "resource_gone" });
		await secondStore.finish("sender", { id: second });
		const accepted = secondStore.redeem("sender", [{ id: second }]);
		try {
			expect(Buffer.from(accepted.images[0]!.data, "base64").equals(bytes)).toBe(true);
		} finally {
			accepted.release();
		}
	} finally {
		firstStore.close();
		secondStore.close();
	}
});

test("upload chunks reject out-of-order, duplicate, noncanonical, cross-connection and bad-digest inputs", async () => {
	const bytes = originalLargePng();
	const store = new PromptImageUploadStore(alwaysConnected);
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
	const store = new PromptImageUploadStore(alwaysConnected);
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
		expect(() => store.append("sender", { id: disconnected.id, sequence: 0, data: "AA==" })).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		await expect(store.finish("sender", { id: disconnected.id })).rejects.toMatchObject({ code: "resource_gone" });
		expect(() => store.discard("sender", { id: disconnected.id })).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		const closed = store.begin("sender", descriptor(bytes));
		store.close();
		await expect(store.finish("sender", { id: closed.id })).rejects.toMatchObject({
			code: "resource_gone",
		});
	} finally {
		store.close();
	}
});

test("live-connection gate rejects queued image mutations after the disconnect sweep", async () => {
	const live = new Set(["sender", "other"]);
	const store = new PromptImageUploadStore(owner => live.has(owner));
	const input = { mimeType: "image/png", byteLength: 1, sha256: "0".repeat(64) };
	try {
		const pending = store.begin("sender", input);
		store.append("sender", { id: pending.id, sequence: 0, data: "AA==" });
		live.delete("sender");
		store.disconnect("sender");
		expect(() => store.begin("sender", input)).toThrow(expect.objectContaining({ code: "resource_gone" }));
		expect(() => store.append("sender", { id: pending.id, sequence: 1, data: "AA==" })).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		await expect(store.finish("sender", { id: pending.id })).rejects.toMatchObject({ code: "resource_gone" });
		expect(() => store.discard("sender", { id: pending.id })).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		expect(() => store.redeem("sender", [{ id: pending.id }])).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		const healthy = store.begin("other", input);
		expect(store.append("other", { id: healthy.id, sequence: 0, data: "AA==" })).toMatchObject({
			receivedBytes: 1,
		});
	} finally {
		store.close();
	}
});

test("expired leases free capacity and a discard during decoding cannot resurrect an upload", async () => {
	const bytes = originalLargePng();
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		vi.useFakeTimers();
		const expired = store.begin("sender", descriptor(bytes));
		store.append("sender", { id: expired.id, sequence: 0, data: bytes.subarray(0, 96 * 1024).toString("base64") });
		vi.advanceTimersByTime(2 * 60_000);
		expect(() => store.append("sender", { id: expired.id, sequence: 1, data: "AA==" })).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		vi.useRealTimers();

		const pending = store.begin("sender", descriptor(bytes));
		for (let offset = 0, sequence = 0; offset < bytes.length; offset += 96 * 1024, sequence++)
			store.append("sender", {
				id: pending.id,
				sequence,
				data: bytes.subarray(offset, offset + 96 * 1024).toString("base64"),
			});
		const finishing = store.finish("sender", { id: pending.id });
		expect(store.discard("sender", { id: pending.id })).toEqual({ discarded: true });
		await expect(finishing).rejects.toMatchObject({ code: "resource_gone" });
		expect(() => store.redeem("sender", [{ id: pending.id }])).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		const next = await stage(store, "sender", bytes);
		const accepted = store.redeem("sender", [{ id: next }]);
		try {
			expect(Buffer.from(accepted.images[0]!.data, "base64").equals(bytes)).toBe(true);
		} finally {
			accepted.release();
		}
	} finally {
		vi.useRealTimers();
		store.close();
	}
});

test("pending uploads enforce the 64 MiB session budget and recover capacity on discard and disconnect", () => {
	const store = new PromptImageUploadStore(alwaysConnected);
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
		expect(store.append("sender", { id: resumed.id, sequence: 0, data: "AA==" })).toMatchObject({
			receivedBytes: 1,
		});
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
	const store = new PromptImageUploadStore(alwaysConnected);
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

test("accepted base64 copies and transient decoding share a process-wide budget across sessions", async () => {
	const original = originalLargePng();
	const image = Buffer.concat([
		original.subarray(0, -12),
		pngChunk("ruSt", Buffer.alloc(19 * 1024 * 1024)),
		original.subarray(-12),
	]);
	const stores = Array.from({ length: 6 }, () => new PromptImageUploadStore(alwaysConnected));
	const releases: Array<() => void> = [];
	try {
		for (const store of stores.slice(0, 5)) {
			const id = await stage(store, "sender", image);
			releases.push(store.redeem("sender", [{ id }]).release);
		}
		const pending = upload(stores[5]!, "sender", image);
		await expect(stores[5]!.finish("sender", { id: pending })).rejects.toMatchObject({ code: "busy" });
		releases[0]!();
		await stores[5]!.finish("sender", { id: pending });
		const recovered = stores[5]!.redeem("sender", [{ id: pending }]);
		try {
			expect(Buffer.from(recovered.images[0]!.data, "base64").equals(image)).toBe(true);
		} finally {
			recovered.release();
		}
	} finally {
		for (const release of releases) release();
		for (const store of stores) store.close();
	}
}, 60_000);

test("discarded in-flight source bytes stay reserved until decode settles, then capacity recovers", async () => {
	const original = originalLargePng();
	const image = Buffer.concat([
		original.subarray(0, -12),
		pngChunk("ruSt", Buffer.alloc(18.5 * 1024 * 1024)),
		original.subarray(-12),
	]);
	const stores = Array.from({ length: 5 }, () => new PromptImageUploadStore(alwaysConnected));
	const pendingStore = stores[4]!;
	const releases: Array<() => void> = [];
	try {
		for (const store of stores.slice(0, 4)) {
			const id = await stage(store, "sender", image);
			releases.push(store.redeem("sender", [{ id }]).release);
		}
		const first = upload(pendingStore, "sender", image);
		const second = upload(pendingStore, "sender", image);
		const finishing = pendingStore.finish("sender", { id: first });
		pendingStore.discard("sender", { id: first });
		const third = upload(pendingStore, "sender", image);
		const fourth = pendingStore.begin("sender", descriptor(image));
		const chunk = image.subarray(0, 96 * 1024).toString("base64");
		let capacityReached = false;
		for (let sequence = 0; sequence < 64; sequence++) {
			try {
				pendingStore.append("sender", { id: fourth.id, sequence, data: chunk });
			} catch (error) {
				expect(error).toMatchObject({ code: "busy" });
				capacityReached = true;
				break;
			}
		}
		expect(capacityReached).toBe(true);
		await expect(finishing).rejects.toMatchObject({ code: "resource_gone" });
		for (const id of [second, third, fourth.id]) pendingStore.discard("sender", { id });
		for (const release of releases) release();
		const recovered = await stage(pendingStore, "sender", original);
		const accepted = pendingStore.redeem("sender", [{ id: recovered }]);
		try {
			expect(Buffer.from(accepted.images[0]!.data, "base64").equals(original)).toBe(true);
		} finally {
			accepted.release();
		}
	} finally {
		for (const release of releases) release();
		for (const store of stores) store.close();
	}
}, 60_000);
