import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TransformedImageInput } from "../src/utils/image-loading";
import { ImageInputTooLargeError } from "../src/utils/image-loading";
import { loadPastedImageBatch, PastedImageBatchError } from "../src/utils/pasted-image-loading";

const RED_1X1_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

describe("loadPastedImageBatch", () => {
	let testDirectory: string;

	beforeEach(async () => {
		testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-pasted-image-loading-"));
	});

	afterEach(async () => {
		await fs.rm(testDirectory, { recursive: true, force: true });
	});

	async function writeImage(name: string, bytes = RED_1X1_PNG): Promise<string> {
		const imagePath = path.join(testDirectory, name);
		await Bun.write(imagePath, bytes);
		return imagePath;
	}

	it("loads structurally valid images from stable descriptors in source order", async () => {
		const first = await writeImage("first.png");
		const second = await writeImage("second.png");
		const result = await loadPastedImageBatch({
			paths: [second, first],
			autoResize: false,
			signal: new AbortController().signal,
		});

		expect(result.sourcePaths).toEqual([second, first]);
		expect(result.images.map(image => image.mimeType)).toEqual(["image/png", "image/png"]);
	});

	it("rejects over-limit direct calls before opening any path", async () => {
		const afterDescriptorOpen = vi.fn();
		const paths = Array.from({ length: 17 }, (_, index) => path.join(testDirectory, `${index}.png`));
		await expect(
			loadPastedImageBatch({
				paths,
				autoResize: false,
				signal: new AbortController().signal,
				dependencies: { afterDescriptorOpen },
			}),
		).rejects.toMatchObject({ code: "too-many" });
		expect(afterDescriptorOpen).not.toHaveBeenCalled();
	});

	it("rejects leaf symlinks instead of following them", async () => {
		const target = await writeImage("private.png");
		const link = path.join(testDirectory, "clipboard-2026-07-19-123456-Ab3.png");
		await fs.symlink(target, link);

		await expect(
			loadPastedImageBatch({ paths: [link], autoResize: false, signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: "unsafe-path" });
	});

	it("rejects hard-linked image leaves", async () => {
		const target = await writeImage("private.png");
		const link = path.join(testDirectory, "linked.png");
		await fs.link(target, link);
		await expect(
			loadPastedImageBatch({ paths: [link], autoResize: false, signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: "unsafe-path" });
	});

	it("keeps automatic clipboard paths inside the canonical temp root", async () => {
		const outsideDirectory = await fs.mkdtemp(path.join(os.homedir(), ".gjc-pasted-image-outside-"));
		const outsideImage = path.join(outsideDirectory, "clipboard-2026-07-19-123456-Ab3.png");
		const linkedParent = path.join(testDirectory, "linked-parent");
		await Bun.write(outsideImage, RED_1X1_PNG);
		await fs.symlink(outsideDirectory, linkedParent);
		const escapedPath = path.join(linkedParent, path.basename(outsideImage));
		try {
			await expect(
				loadPastedImageBatch({
					paths: [escapedPath],
					autoResize: false,
					sourcePolicy: "automatic-temp",
					signal: new AbortController().signal,
				}),
			).rejects.toMatchObject({ code: "unsafe-path" });
			await expect(
				loadPastedImageBatch({
					paths: [escapedPath],
					autoResize: false,
					sourcePolicy: "confirmed",
					signal: new AbortController().signal,
				}),
			).resolves.toMatchObject({ sourcePaths: [escapedPath] });
		} finally {
			await fs.rm(outsideDirectory, { recursive: true, force: true });
		}
	});

	it("snapshots the confirmed path array before asynchronous preflight", async () => {
		const first = await writeImage("first.png");
		const paths = [first];
		const result = await loadPastedImageBatch({
			paths,
			autoResize: false,
			signal: new AbortController().signal,
			dependencies: {
				afterDescriptorOpen: () => {
					paths.push(...Array.from({ length: 16 }, (_, index) => path.join(testDirectory, `${index}.png`)));
				},
			},
		});
		expect(result.sourcePaths).toEqual([first]);
	});

	it("rejects a pathname swap after opening instead of reading the replacement", async () => {
		const original = await writeImage("original.png");
		const replacement = await writeImage("replacement.png");
		const movedOriginal = path.join(testDirectory, "moved-original.png");

		await expect(
			loadPastedImageBatch({
				paths: [original],
				autoResize: false,
				signal: new AbortController().signal,
				dependencies: {
					afterDescriptorOpen: async () => {
						await fs.rename(original, movedOriginal);
						await fs.rename(replacement, original);
					},
				},
			}),
		).rejects.toMatchObject({ code: "unsafe-path" });
	});

	it("enforces source aggregate limits before reading any descriptor", async () => {
		const first = await writeImage("first.png");
		const second = await writeImage("second.png");
		const beforeRead = vi.fn();
		const exactBytes = RED_1X1_PNG.byteLength * 2;

		await expect(
			loadPastedImageBatch({
				paths: [first, second],
				autoResize: false,
				signal: new AbortController().signal,
				maxSourceBytes: exactBytes - 1,
				dependencies: { beforeDescriptorRead: beforeRead },
			}),
		).rejects.toMatchObject({ code: "source-aggregate-too-large" });
		expect(beforeRead).not.toHaveBeenCalled();

		await expect(
			loadPastedImageBatch({
				paths: [first, second],
				autoResize: false,
				signal: new AbortController().signal,
				maxSourceBytes: exactBytes,
			}),
		).resolves.toMatchObject({ sourcePaths: [first, second] });
	});

	it("enforces the per-image source limit before reading", async () => {
		const imagePath = await writeImage("large.png");
		const beforeRead = vi.fn();
		await expect(
			loadPastedImageBatch({
				paths: [imagePath],
				autoResize: false,
				signal: new AbortController().signal,
				maxImageBytes: RED_1X1_PNG.byteLength - 1,
				dependencies: { beforeDescriptorRead: beforeRead },
			}),
		).rejects.toBeInstanceOf(ImageInputTooLargeError);
		expect(beforeRead).not.toHaveBeenCalled();
	});

	it("retains a separate post-transform aggregate limit", async () => {
		const first = await writeImage("first.png");
		const second = await writeImage("second.png");
		const transformImageBytes = vi.fn(
			async (options): Promise<TransformedImageInput> => ({
				resolvedPath: options.resolvedPath,
				mimeType: options.mimeType,
				buffer: Buffer.alloc(10),
				textNote: "test",
				bytes: 10,
			}),
		);

		await expect(
			loadPastedImageBatch({
				paths: [first, second],
				autoResize: true,
				signal: new AbortController().signal,
				maxOutputBytes: 31,
				dependencies: { transformImageBytes },
			}),
		).rejects.toMatchObject({ code: "output-aggregate-too-large" });

		await expect(
			loadPastedImageBatch({
				paths: [first, second],
				autoResize: true,
				signal: new AbortController().signal,
				maxOutputBytes: 32,
				dependencies: { transformImageBytes },
			}),
		).resolves.toMatchObject({ sourcePaths: [first, second] });
	});

	it("rejects a transform result produced after transaction cancellation", async () => {
		const imagePath = await writeImage("cancelled-transform.png");
		const controller = new AbortController();
		const reason = new Error("cancelled during transform");
		await expect(
			loadPastedImageBatch({
				paths: [imagePath],
				autoResize: true,
				signal: controller.signal,
				dependencies: {
					transformImageBytes: async options => {
						controller.abort(reason);
						return {
							resolvedPath: options.resolvedPath,
							mimeType: options.mimeType,
							buffer: Buffer.alloc(1),
							textNote: "test",
							bytes: 1,
						};
					},
				},
			}),
		).rejects.toBe(reason);
	});

	it("rejects signature-only truncated images", async () => {
		const truncated = await writeImage("truncated.png", RED_1X1_PNG.subarray(0, 8));
		await expect(
			loadPastedImageBatch({ paths: [truncated], autoResize: false, signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: "unsupported-image" });
	});

	it("rejects metadata-bearing images without complete pixel structure", async () => {
		const header = Buffer.alloc(26);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
		Buffer.from("IHDR").copy(header, 12);
		header.writeUInt32BE(1, 16);
		header.writeUInt32BE(1, 20);
		header[25] = 2;
		const incomplete = await writeImage("incomplete.png", header);
		await expect(
			loadPastedImageBatch({ paths: [incomplete], autoResize: false, signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: "unsupported-image" });
	});

	it("rejects extreme dimensions before structural decode", async () => {
		const header = Buffer.alloc(26);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
		Buffer.from("IHDR").copy(header, 12);
		header.writeUInt32BE(50_000, 16);
		header.writeUInt32BE(50_000, 20);
		header[25] = 2;
		const extreme = await writeImage("extreme.png", header);

		await expect(
			loadPastedImageBatch({ paths: [extreme], autoResize: false, signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: "dimensions-too-large" });
	});

	it("accepts one-frame GIFs and rejects animated GIF batches", async () => {
		const singleGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
		const imageMarker = singleGif.indexOf(0x2c);
		const trailer = singleGif.lastIndexOf(0x3b);
		const frame = singleGif.subarray(imageMarker, trailer);
		const animatedGif = Buffer.concat([singleGif.subarray(0, imageMarker), frame, frame, Buffer.from([0x3b])]);
		const singlePath = await writeImage("single.gif", singleGif);
		const animatedPath = await writeImage("animated.gif", animatedGif);

		await expect(
			loadPastedImageBatch({ paths: [singlePath], autoResize: false, signal: new AbortController().signal }),
		).resolves.toMatchObject({ sourcePaths: [singlePath] });
		await expect(
			loadPastedImageBatch({ paths: [animatedPath], autoResize: false, signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: "unsupported-image" });
	});

	it("enforces the cumulative decoded-byte budget before native decode", async () => {
		const first = await writeImage("first.png");
		const second = await writeImage("second.png");
		await expect(
			loadPastedImageBatch({
				paths: [first, second],
				autoResize: false,
				signal: new AbortController().signal,
				maxDecodedBytes: 7,
			}),
		).rejects.toMatchObject({ code: "dimensions-too-large" });
		await expect(
			loadPastedImageBatch({
				paths: [first, second],
				autoResize: false,
				signal: new AbortController().signal,
				maxDecodedBytes: 8,
			}),
		).resolves.toMatchObject({ sourcePaths: [first, second] });
	});

	it("aborts before descriptor reads and never returns a late batch", async () => {
		const imagePath = await writeImage("cancelled.png");
		const controller = new AbortController();
		const reason = new Error("paste transaction expired");
		const promise = loadPastedImageBatch({
			paths: [imagePath],
			autoResize: false,
			signal: controller.signal,
			dependencies: {
				beforeDescriptorRead: () => controller.abort(reason),
			},
		});
		await expect(promise).rejects.toBe(reason);
	});

	it("exposes bounded typed failures", () => {
		const error = new PastedImageBatchError("unsafe-path", "unsafe", "/tmp/a.png");
		expect(error.code).toBe("unsafe-path");
		expect(error.imagePath).toBe("/tmp/a.png");
	});
});
