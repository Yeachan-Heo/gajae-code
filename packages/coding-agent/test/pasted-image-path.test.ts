import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePastedImagePath } from "../src/utils/pasted-image-path";

const NNBSP = "\u202f"; // narrow no-break space used by macOS screenshot names

describe("resolvePastedImagePath", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-pasted-image-"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	function writeImage(name: string): string {
		const filePath = path.join(testDir, name);
		fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		return filePath;
	}

	it("resolves a plain absolute path to an existing image", () => {
		const filePath = writeImage("plain.png");
		expect(resolvePastedImagePath(filePath)).toBe(filePath);
	});

	it("resolves a shell-escaped drag-drop path with U+202F before PM", () => {
		// macOS screenshot drag-drop: ASCII spaces are `\ `-escaped, the U+202F
		// before "PM" is left as-is.
		const filePath = writeImage(`Screenshot 2026-07-07 at 11.06.38${NNBSP}PM.png`);
		const pasted = filePath.replaceAll(" ", "\\ ");
		expect(pasted).not.toBe(filePath);
		expect(resolvePastedImagePath(pasted)).toBe(filePath);
	});

	it("resolves shell-escaped parentheses", () => {
		const filePath = writeImage("shot (1).png");
		const pasted = filePath.replaceAll(" ", "\\ ").replaceAll("(", "\\(").replaceAll(")", "\\)");
		expect(resolvePastedImagePath(pasted)).toBe(filePath);
	});

	it("resolves single- and double-quoted paths", () => {
		const filePath = writeImage("quoted image.jpg");
		expect(resolvePastedImagePath(`'${filePath}'`)).toBe(filePath);
		expect(resolvePastedImagePath(`"${filePath}"`)).toBe(filePath);
	});

	it("resolves file:// URIs with percent-encoding", () => {
		const filePath = writeImage("uri image.webp");
		const uri = `file://${filePath.split("/").map(encodeURIComponent).join("/")}`;
		expect(resolvePastedImagePath(uri)).toBe(filePath);
	});

	it("expands ~/ against the provided homedir", () => {
		const filePath = writeImage("home.png");
		expect(resolvePastedImagePath("~/home.png", { homedir: testDir })).toBe(filePath);
	});

	it("resolves relative paths against the provided cwd", () => {
		const filePath = writeImage("relative.png");
		expect(resolvePastedImagePath("./relative.png", { cwd: testDir })).toBe(filePath);
	});

	it("still accepts legacy clipboard temp paths", () => {
		const filePath = writeImage("clipboard-2026-07-07-123456-Ab3.png");
		expect(resolvePastedImagePath(filePath)).toBe(filePath);
	});

	it("rejects nonexistent files", () => {
		expect(resolvePastedImagePath(path.join(testDir, "missing.png"))).toBeUndefined();
	});

	it("rejects directories with image-like names", () => {
		const dirPath = path.join(testDir, "dir.png");
		fs.mkdirSync(dirPath);
		expect(resolvePastedImagePath(dirPath)).toBeUndefined();
	});

	it("rejects non-image extensions", () => {
		const filePath = path.join(testDir, "notes.txt");
		fs.writeFileSync(filePath, "hello");
		expect(resolvePastedImagePath(filePath)).toBeUndefined();
	});

	it("rejects multiline pastes", () => {
		const filePath = writeImage("multi.png");
		expect(resolvePastedImagePath(`${filePath}\nmore text`)).toBeUndefined();
	});

	it("rejects prose around a path (whole paste must be the path)", () => {
		const filePath = writeImage("prose.png");
		expect(resolvePastedImagePath(`look at ${filePath} please`)).toBeUndefined();
	});

	it("rejects empty and whitespace-only pastes", () => {
		expect(resolvePastedImagePath("")).toBeUndefined();
		expect(resolvePastedImagePath("   ")).toBeUndefined();
	});
});
