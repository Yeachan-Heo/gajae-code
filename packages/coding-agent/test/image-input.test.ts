import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readImageMetadata } from "@gajae-code/utils";
import { loadImageInput } from "../src/utils/image-loading";

describe("readImageMetadata", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-image-input-"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("reads PNG metadata from header", async () => {
		const pngHeader = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
			0x00, 0x04, 0x00, 0x00, 0x00, 0x03, 0x08, 0x06, 0x00, 0x00, 0x00,
		]);
		const imagePath = path.join(testDir, "header-only.png");
		fs.writeFileSync(imagePath, pngHeader);

		const metadata = await readImageMetadata(imagePath);
		expect(metadata).not.toBeNull();
		expect(metadata?.mimeType).toBe("image/png");
		expect(metadata?.width).toBe(4);
		expect(metadata?.height).toBe(3);
		expect(metadata?.channels).toBe(4);
		expect(metadata?.hasAlpha).toBe(true);
	});

	it("reads JPEG metadata from header", async () => {
		const jpegHeader = Buffer.from([
			0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00,
			0x03, 0x11, 0x00, 0xff, 0xd9,
		]);
		const imagePath = path.join(testDir, "header-only.jpg");
		fs.writeFileSync(imagePath, jpegHeader);

		const metadata = await readImageMetadata(imagePath);
		expect(metadata).not.toBeNull();
		expect(metadata?.mimeType).toBe("image/jpeg");
		expect(metadata?.width).toBe(3);
		expect(metadata?.height).toBe(2);
		expect(metadata?.channels).toBe(3);
		expect(metadata?.hasAlpha).toBe(false);
	});

	it("returns null for non-image content", async () => {
		const textPath = path.join(testDir, "not-image.bin");
		fs.writeFileSync(textPath, "plain text");

		const metadata = await readImageMetadata(textPath);
		expect(metadata).toBeNull();
	});
});

// 1x1 red PNG seed — upscaled via Bun.Image to synthesize fixtures without binary blobs.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function writeRedPng(dir: string, name: string, width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const bytes = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, bytes);
	return filePath;
}

describe("loadImageInput hard dimension ceiling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-image-clamp-"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("clamps an over-2000px image even when autoResize is disabled", async () => {
		// 2560x1080 ultrawide screenshot — the case that permanently bricks sessions.
		const imagePath = await writeRedPng(testDir, "ultrawide.png", 2560, 1080);

		const result = await loadImageInput({ path: imagePath, cwd: testDir, autoResize: false });

		expect(result).not.toBeNull();
		const { width, height } = await new Bun.Image(Buffer.from(result!.data, "base64")).metadata();
		expect(width).toBeLessThanOrEqual(2000);
		expect(height).toBeLessThanOrEqual(2000);
	});

	it("passes through an in-spec image unchanged when autoResize is disabled", async () => {
		const imagePath = await writeRedPng(testDir, "in-spec.png", 1800, 1600);
		const originalData = fs.readFileSync(imagePath).toString("base64");

		const result = await loadImageInput({ path: imagePath, cwd: testDir, autoResize: false });

		expect(result).not.toBeNull();
		expect(result!.mimeType).toBe("image/png");
		expect(result!.data).toBe(originalData);
		const { width, height } = await new Bun.Image(Buffer.from(result!.data, "base64")).metadata();
		expect(width).toBe(1800);
		expect(height).toBe(1600);
	});
});
