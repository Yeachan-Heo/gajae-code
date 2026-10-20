import { expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createRunResourceLedger, type RunSettlementProof } from "@gajae-code/agent-core";
import { logger } from "@gajae-code/utils";
import {
	getPromptImageProcessBudgetSnapshot,
	PromptImageUploadStore,
	retirePromptImageReservation,
} from "../src/sdk/host/prompt-image-upload";
import { REQUEST_FRAME_BYTES } from "../src/sdk/transport/relay";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CHUNK_BYTES = 96 * 1024;
const alwaysConnected = (_owner: string): boolean => true;
const STATIC_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

test.each([
	"unknown_run",
	"quarantined",
	"run_not_sealed",
	"resources_pending",
	"throw",
	"reject",
] as const)("retirement retains on %s with one diagnostic and no retry", async reason => {
	vi.useFakeTimers();
	const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const release = vi.fn();
	const getProof = vi.fn((): Promise<RunSettlementProof> => {
		if (reason === "throw") throw new Error("ledger unavailable");
		if (reason === "reject") return Promise.reject(new Error("ledger unavailable"));
		return Promise.resolve({ status: "unfenced", reason, pending: [] });
	});
	try {
		retirePromptImageReservation("run", getProof, () => true, release);
		await Promise.resolve();
		vi.advanceTimersByTime(60_000);
		await Promise.resolve();
		expect(getProof).toHaveBeenCalledTimes(1);
		expect(release).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledTimes(1);
		expect(warning.mock.calls[0]?.[0]).toContain("capacity retained");
		expect(warning.mock.calls[0]?.[1]).toMatchObject({
			reason: reason === "throw" || reason === "reject" ? "observation_failed" : reason,
			...(reason === "run_not_sealed" || reason === "resources_pending" ? { contractViolation: true } : {}),
		});
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
		warning.mockRestore();
	}
});

test("retirement waits beyond the former cutoff without timers and releases on one definitive proof", async () => {
	vi.useFakeTimers();
	const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const proof = Promise.withResolvers<RunSettlementProof>();
	const getProof = vi.fn(() => proof.promise);
	const release = vi.fn();
	try {
		retirePromptImageReservation("run", getProof, () => true, release);
		expect(getProof).toHaveBeenCalledWith("run");
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		await Promise.resolve();
		expect(release).not.toHaveBeenCalled();
		expect(warning).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		proof.resolve({ status: "settled" });
		await Promise.resolve();
		expect(getProof).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
		expect(warning).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
		warning.mockRestore();
	}
});

test.each([
	false,
	true,
])("retirement cannot release a stale reservation (initially current: %s)", async initiallyCurrent => {
	vi.useFakeTimers();
	const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
	let current = initiallyCurrent;
	const proof = Promise.withResolvers<RunSettlementProof>();
	const getProof = vi.fn(() => proof.promise);
	const release = vi.fn();
	try {
		retirePromptImageReservation("run", getProof, () => current, release);
		await Promise.resolve();
		current = false;
		proof.resolve({ status: "settled" });
		await Promise.resolve();
		vi.advanceTimersByTime(60_000);
		expect(getProof).toHaveBeenCalledTimes(initiallyCurrent ? 1 : 0);
		expect(release).not.toHaveBeenCalled();
		expect(warning).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
		warning.mockRestore();
	}
});

test("late ledger resource settlement releases accepted capacity after close without timers", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const store = new PromptImageUploadStore(alwaysConnected);
	const bytes = tinyPng();
	const id = await stage(store, "sender", bytes);
	const accepted = store.redeem("sender", [{ id }]);
	const retained = getPromptImageProcessBudgetSnapshot();
	const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const ledger = createRunResourceLedger();
	const resource = Promise.withResolvers<void>();
	ledger.open("run");
	ledger.track("run", "post_prompt", "late image producer", resource.promise);
	ledger.seal("run");
	try {
		expect(retained.sourceBytes - baseline.sourceBytes).toBe(bytes.length + Math.ceil(bytes.length / 3) * 4);
		store.close();
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
		vi.useFakeTimers();
		const release = vi.fn(accepted.release);
		const waitForRunSettlement = vi.fn((handle: string) => ledger.waitForSettlement(handle, { graceMs: null }));
		retirePromptImageReservation("run", waitForRunSettlement, () => true, release);
		await Promise.resolve();
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		await Promise.resolve();
		expect(release).not.toHaveBeenCalled();
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
		expect(warning).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		resource.resolve();
		await resource.promise;
		await Promise.resolve();
		expect(waitForRunSettlement).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
		accepted.release();
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
		expect(warning).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		resource.resolve();
		accepted.release();
		store.close();
		vi.useRealTimers();
		warning.mockRestore();
	}
});

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

function tinyPng(seed = 17): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(Buffer.from([0, seed & 255, (seed + 1) & 255, (seed + 2) & 255]))),
		pngChunk("IEND"),
	]);
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
const descriptor = (bytes: Buffer, mimeType = "image/png") => ({
	mimeType,
	byteLength: bytes.length,
	sha256: digest(bytes),
});

function upload(
	store: PromptImageUploadStore,
	owner: string,
	bytes: Buffer,
	batchId?: string,
	mimeType = "image/png",
): string {
	const input = descriptor(bytes, mimeType);
	const { id } = store.begin(owner, batchId === undefined ? input : { ...input, batchId });
	let sequence = 0;
	for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
		const chunk = bytes.subarray(offset, offset + MAX_CHUNK_BYTES);
		expect(store.append(owner, { id, sequence, data: chunk.toString("base64") })).toEqual({
			id,
			nextSequence: ++sequence,
			receivedBytes: offset + chunk.length,
		});
	}
	return id;
}

async function stage(
	store: PromptImageUploadStore,
	owner: string,
	bytes: Buffer,
	batchId?: string,
	mimeType = "image/png",
): Promise<string> {
	const id = upload(store, owner, bytes, batchId, mimeType);
	await store.finish(owner, { id });
	return id;
}

function animatedGif(commentBytes = 0): Buffer {
	const imageMarker = STATIC_GIF.indexOf(0x2c);
	const trailer = STATIC_GIF.lastIndexOf(0x3b);
	const frame = STATIC_GIF.subarray(imageMarker, trailer);
	const comment: Buffer[] = [];
	if (commentBytes > 0) {
		comment.push(Buffer.from([0x21, 0xfe]));
		for (let remaining = commentBytes; remaining > 0; ) {
			const blockLength = Math.min(remaining, 255);
			comment.push(Buffer.from([blockLength]), Buffer.alloc(blockLength, 0x61));
			remaining -= blockLength;
		}
		comment.push(Buffer.from([0]));
	}
	return Buffer.concat([STATIC_GIF.subarray(0, imageMarker), frame, frame, ...comment, Buffer.from([0x3b])]);
}

function fillNearLimit(store: PromptImageUploadStore): string[] {
	const fullChunk = Buffer.alloc(MAX_CHUNK_BYTES).toString("base64");
	const finalChunk = Buffer.alloc(MAX_CHUNK_BYTES - 1).toString("base64");
	const chunkCounts = [171, 171, 170, 170];
	const ids: string[] = [];
	for (const chunkCount of chunkCounts) {
		const { id } = store.begin("sender", {
			mimeType: "image/png",
			byteLength: 20 * 1024 * 1024,
			sha256: "0".repeat(64),
		});
		ids.push(id);
		for (let sequence = 0; sequence < chunkCount - 1; sequence++)
			store.append("sender", { id, sequence, data: fullChunk });
		store.append("sender", { id, sequence: chunkCount - 1, data: finalChunk });
	}
	return ids;
}

test("every store mutation requires an authenticated connection", async () => {
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const id = upload(store, "sender", tinyPng());
		for (const mutate of [
			() => store.begin(undefined, descriptor(tinyPng())),
			() => store.append(undefined, { id, sequence: 1, data: "AA==" }),
			() => store.discard(undefined, { id }),
			() => store.redeem(undefined, [{ id }]),
		])
			expect(mutate).toThrow(expect.objectContaining({ code: "operation_prohibited" }));
		await expect(store.finish(undefined, { id })).rejects.toMatchObject({ code: "operation_prohibited" });
		await store.finish("sender", { id });
		store.redeem("sender", [{ id }]).release();
	} finally {
		store.close();
	}
});

test("16 concurrent leases are admitted, a 17th is denied, and discard recovers the slot", () => {
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const ids = Array.from({ length: 16 }, () => store.begin("sender", descriptor(tinyPng())).id);
		expect(new Set(ids).size).toBe(16);
		expect(() => store.begin("sender", descriptor(tinyPng()))).toThrow(expect.objectContaining({ code: "busy" }));
		store.discard("sender", { id: ids[0] });
		const replacement = store.begin("sender", descriptor(tinyPng()));
		expect(ids).not.toContain(replacement.id);
	} finally {
		store.close();
	}
});

test("redemption rejects 17 IDs before lookup or consuming a valid lease", async () => {
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const id = await stage(store, "sender", tinyPng());
		const ids = [{ id }, ...Array.from({ length: 16 }, (_, index) => ({ id: `missing-${index}` }))];
		expect(() => store.redeem("sender", ids)).toThrow(expect.objectContaining({ code: "invalid_input" }));
		store.redeem("sender", [{ id }]).release();
	} finally {
		store.close();
	}
});

test.each(["", 1, null, undefined, "a".repeat(129)])("invalid batch ID %j does not consume a lease", batchId => {
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		expect(() => store.begin("sender", { ...descriptor(tinyPng()), batchId })).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		for (let index = 0; index < 16; index++)
			store.begin("sender", { ...descriptor(tinyPng()), batchId: "a".repeat(128) });
	} finally {
		store.close();
	}
});

test("same-ID concurrent finish is rejected without changing the first decoder's reservation", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const id = upload(store, "sender", tinyPng());
		const finishing = store.finish("sender", { id });
		const active = getPromptImageProcessBudgetSnapshot();
		expect(active.concurrentFinishes).toBe(baseline.concurrentFinishes + 1);
		const duplicate = store.finish("sender", { id });
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(active);
		await Promise.all([
			expect(duplicate).rejects.toMatchObject({ code: "invalid_input" }),
			expect(finishing).resolves.toMatchObject({ id }),
		]);
		store.redeem("sender", [{ id }]).release();
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	} finally {
		store.close();
	}
});

test("a session has one decoder slot and recovers it after finishing", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const first = upload(store, "sender", tinyPng());
		const second = upload(store, "sender", tinyPng(31));
		const finishing = store.finish("sender", { id: first });
		const active = getPromptImageProcessBudgetSnapshot();
		const competing = store.finish("sender", { id: second });
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(active);
		await Promise.all([
			expect(competing).rejects.toMatchObject({ code: "busy" }),
			expect(finishing).resolves.toMatchObject({ id: first }),
		]);
		await store.finish("sender", { id: second });
		store.redeem("sender", [{ id: first }, { id: second }]).release();
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	} finally {
		store.close();
	}
});

test.each([
	"unknown_run",
	"quarantined",
	"throw",
	"reject",
] as const)("accepted image stays charged after close on %s", async reason => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const store = new PromptImageUploadStore(alwaysConnected);
	const id = await stage(store, "sender", tinyPng());
	const accepted = store.redeem("sender", [{ id }]);
	const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const ledger = createRunResourceLedger();
	if (reason === "quarantined") {
		ledger.open("run");
		ledger.quarantine("run");
	}
	try {
		const retained = getPromptImageProcessBudgetSnapshot();
		expect(retained.sourceBytes).toBeGreaterThan(baseline.sourceBytes);
		vi.useFakeTimers();
		const release = vi.fn(accepted.release);
		const waitForRunSettlement = vi.fn((handle: string): Promise<RunSettlementProof> => {
			if (reason === "throw") throw new Error("ledger unavailable");
			if (reason === "reject") return Promise.reject(new Error("ledger unavailable"));
			return ledger.waitForSettlement(handle, { graceMs: null });
		});
		retirePromptImageReservation("run", waitForRunSettlement, () => true, release);
		store.close();
		await Promise.resolve();
		vi.advanceTimersByTime(60_000);
		expect(waitForRunSettlement).toHaveBeenCalledTimes(1);
		expect(release).not.toHaveBeenCalled();
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
		expect(warning).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		// Test-owned cleanup only; production teardown must not release a live producer.
		accepted.release();
		store.close();
		vi.useRealTimers();
		warning.mockRestore();
	}
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("one prompt can redeem exactly 64 MiB, while staging cannot supply a larger prompt", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const original = tinyPng();
	const image = Buffer.concat([
		original.subarray(0, -12),
		pngChunk("ruSt", Buffer.alloc(16 * 1024 * 1024 - original.length - 12)),
		original.subarray(-12),
	]);
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const ids: string[] = [];
		for (let index = 0; index < 4; index++) ids.push(await stage(store, "sender", image));
		const excess = store.begin("sender", descriptor(tinyPng()));
		expect(() => store.append("sender", { id: excess.id, sequence: 0, data: "AA==" })).toThrow(
			expect.objectContaining({ code: "busy" }),
		);
		const accepted = store.redeem(
			"sender",
			ids.map(id => ({ id })),
		);
		try {
			expect(accepted.images.reduce((total, content) => total + Buffer.byteLength(content.data, "base64"), 0)).toBe(
				64 * 1024 * 1024,
			);
		} finally {
			accepted.release();
		}
	} finally {
		store.close();
	}
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
}, 60_000);

test("close during finish retains decoder-owned bytes until completion, then counters recover", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const id = upload(store, "sender", tinyPng());
		const finishing = store.finish("sender", { id });
		const active = getPromptImageProcessBudgetSnapshot();
		expect(active.sourceBytes).toBeGreaterThan(baseline.sourceBytes);
		expect(active.transientBytes).toBeGreaterThan(baseline.transientBytes);
		store.close();
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(active);
		expect(() => store.redeem("sender", [{ id }])).toThrow(expect.objectContaining({ code: "resource_gone" }));
		await expect(finishing).rejects.toMatchObject({ code: "resource_gone" });
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	} finally {
		store.close();
	}
});

test("unknown, cross-owner and consumed IDs share an image-specific error, not a session error", async () => {
	let connected = true;
	const store = new PromptImageUploadStore(() => connected);
	try {
		const id = await stage(store, "sender", tinyPng());
		for (const [owner, requested] of [
			["sender", "missing"],
			["other", id],
		])
			expect(() => store.redeem(owner, [{ id: requested }])).toThrow(
				expect.objectContaining({ code: "image_upload_unavailable" }),
			);
		store.redeem("sender", [{ id }]).release();
		expect(() => store.redeem("sender", [{ id }])).toThrow(
			expect.objectContaining({ code: "image_upload_unavailable" }),
		);
		connected = false;
		expect(() => store.redeem("sender", [{ id }])).toThrow(expect.objectContaining({ code: "resource_gone" }));
	} finally {
		store.close();
	}
});

test("decoded dimension mismatches retain their specific validation error and recover counters", async () => {
	const bytes = tinyPng();
	const metadata = await new Bun.Image(bytes).metadata();
	const decode = vi.spyOn(Bun.Image.prototype, "metadata").mockResolvedValue({ ...metadata, width: 2 });
	const baseline = getPromptImageProcessBudgetSnapshot();
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const id = upload(store, "sender", bytes);
		await expect(store.finish("sender", { id })).rejects.toMatchObject({
			code: "invalid_input",
			message: "Image dimensions do not match decoded data.",
		});
		store.discard("sender", { id });
		expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	} finally {
		decode.mockRestore();
		store.close();
	}
});

test("a valid original image larger than 256 KiB survives chunk upload and one-shot redemption byte for byte", async () => {
	const bytes = originalLargePng();
	expect(bytes.length).toBeGreaterThan(256 * 1024);
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const id = await stage(store, "sender", bytes);
		const accepted = store.redeem("sender", [{ id }]);
		try {
			expect(accepted.images).toHaveLength(1);
			expect(accepted.images[0]?.mimeType).toBe("image/png");
			expect(Buffer.from(accepted.images[0]!.data, "base64").equals(bytes)).toBe(true);
			expect(() => store.redeem("sender", [{ id }])).toThrow(
				expect.objectContaining({ code: "image_upload_unavailable" }),
			);
			accepted.release();
			accepted.release();
		} finally {
			accepted.release();
		}
	} finally {
		store.close();
	}
});

test.each([
	["two-frame GIF", animatedGif(), 0],
	["two-frame GIF larger than 256 KiB", animatedGif(REQUEST_FRAME_BYTES + 1), REQUEST_FRAME_BYTES],
] as const)("finish rejects %s and discard permits a static GIF roundtrip", async (_description, bytes, minimumBytes) => {
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		expect(bytes.length).toBeGreaterThan(minimumBytes);
		expect(bytes.length).toBeLessThanOrEqual(20 * 1024 * 1024);
		expect(await new Bun.Image(bytes).metadata()).toMatchObject({ width: 1, height: 1 });
		const id = upload(store, "sender", bytes, undefined, "image/gif");
		await expect(store.finish("sender", { id })).rejects.toMatchObject({ code: "invalid_input" });
		expect(() => store.redeem("sender", [{ id }])).toThrow(expect.objectContaining({ code: "invalid_input" }));
		expect(store.discard("sender", { id })).toEqual({ discarded: true });

		const staticId = await stage(store, "sender", STATIC_GIF, undefined, "image/gif");
		const accepted = store.redeem("sender", [{ id: staticId }]);
		try {
			expect(accepted.images[0]?.mimeType).toBe("image/gif");
			expect(Buffer.from(accepted.images[0]!.data, "base64").equals(STATIC_GIF)).toBe(true);
		} finally {
			accepted.release();
		}
	} finally {
		store.close();
	}
});

test("one-byte fragments use bounded slabs and preserve image bytes", async () => {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 2;
	const core = Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(Buffer.from([0, 17, 34, 51]))),
		pngChunk("IEND"),
	]);
	const byteLength = 100_000;
	const bytes = Buffer.concat([
		core.subarray(0, -12),
		pngChunk("ruSt", Buffer.alloc(byteLength - core.length - 12)),
		core.subarray(-12),
	]);
	const encodedByte = Array.from({ length: 256 }, (_, value) => Buffer.from([value]).toString("base64"));
	const store = new PromptImageUploadStore(alwaysConnected);
	const allocatedSizes: number[] = [];
	const allocate = Buffer.allocUnsafeSlow;
	const allocations = vi.spyOn(Buffer, "allocUnsafeSlow").mockImplementation(size => {
		allocatedSizes.push(size);
		return allocate(size);
	});
	try {
		const { id } = store.begin("sender", descriptor(bytes));
		for (let offset = 0; offset < bytes.length; offset++)
			store.append("sender", { id, sequence: offset, data: encodedByte[bytes[offset]!]! });
		expect(allocatedSizes).toEqual([MAX_CHUNK_BYTES, byteLength - MAX_CHUNK_BYTES]);
		allocations.mockRestore();
		await store.finish("sender", { id });
		const accepted = store.redeem("sender", [{ id }]);
		try {
			expect(Buffer.from(accepted.images[0]!.data, "base64").equals(bytes)).toBe(true);
		} finally {
			accepted.release();
		}
	} finally {
		allocations.mockRestore();
		store.close();
	}
});

test("invalid declarations, chunks, digests and MIME labels are rejected", async () => {
	const bytes = tinyPng();
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		for (const input of [
			{ ...descriptor(bytes), mimeType: "image/svg+xml" },
			{ ...descriptor(bytes), byteLength: 0 },
			{ ...descriptor(bytes), sha256: "bad" },
			{ ...descriptor(bytes), extra: true },
		])
			expect(() => store.begin("sender", input)).toThrow(expect.objectContaining({ code: "invalid_input" }));

		const { id } = store.begin("sender", descriptor(bytes));
		const encoded = bytes.toString("base64");
		expect(() => store.append("sender", { id, sequence: 1, data: encoded })).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		expect(() => store.append("sender", { id, sequence: 0, data: `${encoded}\n` })).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		store.append("sender", { id, sequence: 0, data: encoded });
		expect(() => store.append("sender", { id, sequence: 0, data: encoded })).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		await store.finish("sender", { id });

		const wrongMime = store.begin("sender", { ...descriptor(bytes), mimeType: "image/jpeg" });
		store.append("sender", { id: wrongMime.id, sequence: 0, data: encoded });
		await expect(store.finish("sender", { id: wrongMime.id })).rejects.toMatchObject({ code: "invalid_input" });
		const wrongDigest = store.begin("sender", { ...descriptor(bytes), sha256: "0".repeat(64) });
		store.append("sender", { id: wrongDigest.id, sequence: 0, data: encoded });
		await expect(store.finish("sender", { id: wrongDigest.id })).rejects.toMatchObject({ code: "invalid_input" });
	} finally {
		store.close();
	}
});

test("redemption is atomic, ordered and connection-owned; discard and disconnect remove their leases", async () => {
	const firstBytes = originalLargePng();
	const secondBytes = originalLargePng(0x87654321);
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const first = await stage(store, "sender", firstBytes);
		const second = await stage(store, "sender", secondBytes);
		expect(() => store.redeem("other", [{ id: first }])).toThrow(
			expect.objectContaining({ code: "image_upload_unavailable" }),
		);
		expect(() => store.redeem("sender", [{ id: first }, { id: first }])).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		expect(() => store.redeem("sender", [{ id: first }, { id: "missing" }])).toThrow(
			expect.objectContaining({ code: "image_upload_unavailable" }),
		);
		const accepted = store.redeem("sender", [{ id: second }, { id: first }]);
		try {
			expect(accepted.images.map(image => image.data)).toEqual([
				secondBytes.toString("base64"),
				firstBytes.toString("base64"),
			]);
		} finally {
			accepted.release();
		}
		for (const id of [first, second])
			expect(() => store.redeem("sender", [{ id }])).toThrow(
				expect.objectContaining({ code: "image_upload_unavailable" }),
			);

		const discarded = store.begin("sender", descriptor(firstBytes));
		expect(store.discard("sender", { id: discarded.id })).toEqual({ discarded: true });
		expect(() => store.append("sender", { id: discarded.id, sequence: 0, data: "AQ==" })).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		const disconnected = store.begin("sender", descriptor(firstBytes));
		store.disconnect("sender");
		expect(() => store.redeem("sender", [{ id: disconnected.id }])).toThrow(
			expect.objectContaining({ code: "image_upload_unavailable" }),
		);
	} finally {
		store.close();
	}
});

test("live-connection checks reject queued mutations after disconnect", async () => {
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

test("finish rechecks transport liveness after decoding even without a disconnect callback", async () => {
	const live = new Set(["sender"]);
	const store = new PromptImageUploadStore(owner => live.has(owner));
	try {
		const id = upload(store, "sender", tinyPng());
		const finishing = store.finish("sender", { id });
		live.delete("sender");
		await expect(finishing).rejects.toMatchObject({ code: "resource_gone" });
		live.add("sender");
		expect(() => store.redeem("sender", [{ id }])).toThrow(
			expect.objectContaining({ code: "image_upload_unavailable" }),
		);
		const replacement = await stage(store, "sender", tinyPng());
		store.redeem("sender", [{ id: replacement }]).release();
	} finally {
		store.close();
	}
});

test.each([
	"append",
	"finish",
	"discard",
	"redeem",
] as const)("%s enforces the absolute lease deadline without timer delivery", async operation => {
	let now = 1_700_000_000_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const store = new PromptImageUploadStore(alwaysConnected);
	const bytes = tinyPng();
	try {
		const id = operation === "redeem" ? await stage(store, "sender", bytes) : upload(store, "sender", bytes);
		now += 120_000;
		if (operation === "append")
			expect(() => store.append("sender", { id, sequence: 1, data: "AA==" })).toThrow(
				expect.objectContaining({ code: "resource_gone" }),
			);
		else if (operation === "finish")
			await expect(store.finish("sender", { id })).rejects.toMatchObject({ code: "resource_gone" });
		else if (operation === "discard")
			expect(() => store.discard("sender", { id })).toThrow(expect.objectContaining({ code: "resource_gone" }));
		else
			expect(() => store.redeem("sender", [{ id }])).toThrow(
				expect.objectContaining({ code: "image_upload_unavailable" }),
			);
	} finally {
		store.close();
		clock.mockRestore();
	}
});

test("timer expiry removes leases even when no operation observes the deadline", () => {
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		vi.useFakeTimers();
		const pending = store.begin("sender", { mimeType: "image/png", byteLength: 1, sha256: "0".repeat(64) });
		store.append("sender", { id: pending.id, sequence: 0, data: "AA==" });
		vi.advanceTimersByTime(120_000);
		expect(() => store.append("sender", { id: pending.id, sequence: 1, data: "AQ==" })).toThrow(
			expect.objectContaining({ code: "resource_gone" }),
		);
		const replacement = store.begin("sender", { mimeType: "image/png", byteLength: 1, sha256: "0".repeat(64) });
		expect(store.append("sender", { id: replacement.id, sequence: 0, data: "AA==" })).toMatchObject({
			receivedBytes: 1,
		});
	} finally {
		vi.useRealTimers();
		store.close();
	}
});

test("batch lease renewal stays within its owner and batch", async () => {
	let now = 1_700_000_000_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const store = new PromptImageUploadStore(alwaysConnected);
	const bytes = tinyPng();
	try {
		const sameBatch = await stage(store, "owner", bytes, "shared");
		const otherBatch = await stage(store, "owner", bytes, "different");
		const otherOwner = await stage(store, "other-owner", bytes, "shared");
		now += 119_000;
		store.begin("owner", { ...descriptor(bytes), batchId: "shared" });
		now += 2_000;
		const accepted = store.redeem("owner", [{ id: sameBatch }]);
		accepted.release();
		expect(() => store.redeem("owner", [{ id: otherBatch }])).toThrow(
			expect.objectContaining({ code: "image_upload_unavailable" }),
		);
		expect(() => store.redeem("other-owner", [{ id: otherOwner }])).toThrow(
			expect.objectContaining({ code: "image_upload_unavailable" }),
		);
	} finally {
		store.close();
		clock.mockRestore();
	}
});

test("discard during decoding cannot resurrect a lease or block another session's decoder", async () => {
	const bytes = originalLargePng();
	const firstStore = new PromptImageUploadStore(alwaysConnected);
	const secondStore = new PromptImageUploadStore(alwaysConnected);
	try {
		const first = upload(firstStore, "sender", bytes);
		const second = upload(secondStore, "sender", bytes);
		const finishing = firstStore.finish("sender", { id: first });
		firstStore.discard("sender", { id: first });
		const competing = secondStore.finish("sender", { id: second });
		await Promise.all([
			expect(finishing).rejects.toMatchObject({ code: "resource_gone" }),
			expect(competing).resolves.toMatchObject({ id: second }),
		]);
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

test("pending-upload quota is recovered after discard and disconnect", () => {
	const store = new PromptImageUploadStore(alwaysConnected);
	try {
		const ids = fillNearLimit(store);
		const crossingChunk = Buffer.from([1, 2]).toString("base64");
		expect(() => store.append("sender", { id: ids[3]!, sequence: 170, data: crossingChunk })).toThrow(
			expect.objectContaining({ code: "busy" }),
		);
		store.discard("sender", { id: ids[0] });
		expect(store.append("sender", { id: ids[3]!, sequence: 170, data: crossingChunk })).toMatchObject({
			nextSequence: 171,
		});
		store.disconnect("sender");
		const replacement = store.begin("sender", {
			mimeType: "image/png",
			byteLength: 20 * 1024 * 1024,
			sha256: "0".repeat(64),
		});
		expect(
			store.append("sender", {
				id: replacement.id,
				sequence: 0,
				data: Buffer.alloc(MAX_CHUNK_BYTES).toString("base64"),
			}),
		).toMatchObject({ receivedBytes: MAX_CHUNK_BYTES });
	} finally {
		store.close();
	}
});

test("finish crossing an elapsed lease deadline rejects and releases decoder reservations", async () => {
	let now = 1_700_000_000_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const store = new PromptImageUploadStore(alwaysConnected);
	const bytes = tinyPng();
	try {
		const id = upload(store, "sender", bytes);
		const finishing = store.finish("sender", { id });
		now += 120_000;
		await expect(finishing).rejects.toMatchObject({ code: "resource_gone" });
		expect(() => store.redeem("sender", [{ id }])).toThrow(
			expect.objectContaining({ code: "image_upload_unavailable" }),
		);
		const replacement = await stage(store, "sender", bytes);
		store.redeem("sender", [{ id: replacement }]).release();
	} finally {
		store.close();
		clock.mockRestore();
	}
});

test("batch renewal cannot revive a peer expiring between admission sweep and renewal", async () => {
	let now = 1_700_000_000_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const store = new PromptImageUploadStore(alwaysConnected);
	const bytes = tinyPng();
	try {
		const peer = await stage(store, "sender", bytes, "same-batch");
		now += 119_999;
		clock.mockImplementationOnce(() => now++);
		const fresh = store.begin("sender", { ...descriptor(bytes), batchId: "same-batch" });
		expect(() => store.redeem("sender", [{ id: peer }])).toThrow(
			expect.objectContaining({ code: "image_upload_unavailable" }),
		);
		store.append("sender", { id: fresh.id, sequence: 0, data: bytes.toString("base64") });
		await store.finish("sender", { id: fresh.id });
		const accepted = store.redeem("sender", [{ id: fresh.id }]);
		try {
			expect(Buffer.from(accepted.images[0]!.data, "base64").equals(bytes)).toBe(true);
		} finally {
			accepted.release();
		}
	} finally {
		store.close();
		clock.mockRestore();
	}
});

test("accepted images hold the 64 MiB session quota until idempotent release", async () => {
	const original = originalLargePng();
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

test("accepted base64 copies and transient decoding share a process-wide budget", async () => {
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

test("discarded in-flight source bytes remain reserved until decode settles, then capacity recovers", async () => {
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
		const chunk = image.subarray(0, MAX_CHUNK_BYTES).toString("base64");
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
