import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import {
	decodePastedPathCandidate,
	decodePastedPathCandidates,
	formatPastedImageReference,
	resolvePastedImagePath,
	resolvePastedImagePaths,
} from "../src/utils/pasted-image-path";

const NNBSP = "\u202f"; // narrow no-break space used by macOS screenshot names

describe("resolvePastedImagePath", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-pasted-image-"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	function writeImage(name: string): string {
		const filePath = path.join(testDir, name);
		fs.writeFileSync(filePath, PNG_SIGNATURE);
		return filePath;
	}

	it("does not auto-attach arbitrary absolute image paths", () => {
		const filePath = writeImage("plain.png");
		expect(resolvePastedImagePath(filePath)).toBeUndefined();
	});

	it("does not auto-attach shell-escaped drag-drop image paths", () => {
		// Saved image paths remain literal text; attach them explicitly with @path/to/image.png.
		const filePath = writeImage(`Screenshot 2026-07-07 at 11.06.38${NNBSP}PM.png`);
		const pasted = filePath.replaceAll(" ", "\\ ");
		expect(pasted).not.toBe(filePath);
		expect(resolvePastedImagePath(pasted)).toBeUndefined();
	});

	it("does not auto-attach quoted arbitrary image paths", () => {
		const filePath = writeImage("quoted image.jpg");
		expect(resolvePastedImagePath(`'${filePath}'`)).toBeUndefined();
		expect(resolvePastedImagePath(`"${filePath}"`)).toBeUndefined();
	});

	it("does not auto-attach arbitrary file:// image URIs", () => {
		const filePath = writeImage("uri image.webp");
		const uri = `file://${filePath.split("/").map(encodeURIComponent).join("/")}`;
		expect(resolvePastedImagePath(uri)).toBeUndefined();
	});

	it("does not auto-attach arbitrary ~/ or relative image paths", () => {
		const homeImage = writeImage("home.png");
		const relativeImage = writeImage("relative.png");
		expect(resolvePastedImagePath("~/home.png", { homedir: testDir })).toBeUndefined();
		expect(resolvePastedImagePath("./relative.png", { cwd: testDir })).toBeUndefined();
		expect(homeImage).toBeTruthy();
		expect(relativeImage).toBeTruthy();
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

	it("rejects existing non-image files with image extensions (content sniffing)", () => {
		// Regression (#1841 review): consuming this paste would lose the raw
		// path once the image loader rejects the content.
		const filePath = path.join(testDir, "not-image.png");
		fs.writeFileSync(filePath, "hello, I am a text file");
		expect(resolvePastedImagePath(filePath)).toBeUndefined();
	});

	it("rejects empty files with image extensions", () => {
		const filePath = path.join(testDir, "empty.png");
		fs.writeFileSync(filePath, "");
		expect(resolvePastedImagePath(filePath)).toBeUndefined();
	});

	it("accepts each supported image signature for recognized clipboard temp paths", () => {
		const signatures: Array<[string, Buffer]> = [
			["clipboard-2026-07-07-123456-png.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
			["clipboard-2026-07-07-123456-jpg.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])],
			["clipboard-2026-07-07-123456-gif.gif", Buffer.from("GIF89a", "latin1")],
			[
				"clipboard-2026-07-07-123456-webp.webp",
				Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1")]),
			],
		];
		for (const [name, magic] of signatures) {
			const filePath = path.join(testDir, name);
			fs.writeFileSync(filePath, magic);
			expect(resolvePastedImagePath(filePath)).toBe(filePath);
		}
	});

	it("accepts mismatched extension when recognized clipboard temp content is a supported image", () => {
		const filePath = path.join(testDir, "clipboard-2026-07-07-123456-actually-png.jpg");
		fs.writeFileSync(filePath, PNG_SIGNATURE);
		expect(resolvePastedImagePath(filePath)).toBe(filePath);
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

describe("resolvePastedImagePaths", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-pasted-images-"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	function writeImage(name: string): string {
		const filePath = path.join(testDir, name);
		fs.writeFileSync(filePath, PNG_SIGNATURE);
		return filePath;
	}

	it("accepts at least two saved image paths and preserves source order", () => {
		const first = writeImage("first.png");
		const second = writeImage("second.jpg");
		expect(resolvePastedImagePaths(`${second} ${first} ${second}`)).toEqual([second, first, second]);
	});

	it("supports POSIX escapes plus single-quoted and double-quoted paths", () => {
		const escaped = writeImage("escaped path.png");
		const singleQuoted = writeImage("single quoted.jpg");
		const doubleQuoted = writeImage("double quoted.webp");
		const paste = `${escaped.replaceAll(" ", "\\ ")} '${singleQuoted}' "${doubleQuoted}"`;
		expect(resolvePastedImagePaths(paste)).toEqual([escaped, singleQuoted, doubleQuoted]);
	});

	it("resolves a macOS multi-screenshot paste with escaped spaces and U+202F", () => {
		const first = writeImage(`Screenshot 2026-07-19 at 3.21.27${NNBSP}PM.png`);
		const second = writeImage(`Screenshot 2026-07-19 at 3.21.29${NNBSP}PM.png`);
		const paste = `${first.replaceAll(" ", "\\ ")} ${second.replaceAll(" ", "\\ ")}`;
		expect(resolvePastedImagePaths(paste)).toEqual([first, second]);
	});

	it("resolves complete lists of local file URLs", () => {
		const first = writeImage("first uri.png");
		const second = writeImage("second uri.jpg");
		const paste = `${url.pathToFileURL(first).href}\n${url.pathToFileURL(second).href}`;
		expect(resolvePastedImagePaths(paste)).toEqual([first, second]);
	});

	it("splits on ASCII whitespace while retaining U+202F inside screenshot names", () => {
		const first = writeImage(`Screenshot${NNBSP}AM.png`);
		const second = writeImage(`Screenshot${NNBSP}PM.png`);
		expect(resolvePastedImagePaths(`\t${first}\r\n\f\v${second} `)).toEqual([first, second]);
	});

	it("resolves relative and home-relative paths for saved-image lists", () => {
		const relative = writeImage("relative.png");
		const homeRelative = writeImage("home.jpg");
		expect(resolvePastedImagePaths("./relative.png ~/home.jpg", { cwd: testDir, homedir: testDir })).toEqual([
			relative,
			homeRelative,
		]);
	});

	it("retains the single-candidate clipboard-temp policy", () => {
		const saved = writeImage("saved.png");
		const clipboard = writeImage("clipboard-2026-07-19-095500-A1.png");
		expect(resolvePastedImagePaths(saved)).toBeUndefined();
		expect(resolvePastedImagePaths(clipboard)).toEqual([clipboard]);
	});

	it("rejects the complete list when any candidate is missing or unsupported", () => {
		const valid = writeImage("valid.png");
		const missing = path.join(testDir, "missing.png");
		const textFile = path.join(testDir, "not-an-image.jpg");
		fs.writeFileSync(textFile, "not an image");
		expect(resolvePastedImagePaths(`${valid} ${missing}`)).toBeUndefined();
		expect(resolvePastedImagePaths(`${valid} ${textFile}`)).toBeUndefined();
	});

	it("rejects directories, non-image extensions, and prose anywhere in the list", () => {
		const valid = writeImage("valid.png");
		const directory = path.join(testDir, "directory.png");
		const textFile = path.join(testDir, "notes.txt");
		fs.mkdirSync(directory);
		fs.writeFileSync(textFile, PNG_SIGNATURE);
		expect(resolvePastedImagePaths(`${valid} ${directory}`)).toBeUndefined();
		expect(resolvePastedImagePaths(`${valid} ${textFile}`)).toBeUndefined();
		expect(resolvePastedImagePaths(`${valid} explanatory text`)).toBeUndefined();
	});

	it("rejects malformed quoting and dangling POSIX escapes", () => {
		const first = writeImage("first.png");
		const second = writeImage("second.png");
		expect(resolvePastedImagePaths(`'${first} ${second}`)).toBeUndefined();
		expect(resolvePastedImagePaths(`"${first} ${second}`)).toBeUndefined();
		expect(resolvePastedImagePaths(`${first} ${second}\\`)).toBeUndefined();
		expect(resolvePastedImagePaths(`${first} '' ${second}`)).toBeUndefined();
	});
});

describe("decodePastedPathCandidates", () => {
	it("decodes shell-like quoting, escaping, and concatenated quoted segments", () => {
		expect(
			decodePastedPathCandidates(`alpha\\ beta.png 'gamma delta'.jpg "epsilon zeta".webp`, {
				platform: "linux",
			}),
		).toEqual(["alpha beta.png", "gamma delta.jpg", "epsilon zeta.webp"]);
	});

	it("uses only ASCII whitespace as separators", () => {
		expect(decodePastedPathCandidates(`first${NNBSP}image.png\tsecond.jpg\nthird.webp`)).toEqual([
			`first${NNBSP}image.png`,
			"second.jpg",
			"third.webp",
		]);
	});

	it("preserves Windows path-separator backslashes", () => {
		expect(
			decodePastedPathCandidates(String.raw`C:\Users\me\one.png "D:\Saved Images\two.jpg"`, {
				platform: "win32",
			}),
		).toEqual([String.raw`C:\Users\me\one.png`, String.raw`D:\Saved Images\two.jpg`]);
	});

	it("decodes file URLs independently and rejects an invalid member", () => {
		expect(
			decodePastedPathCandidates("file:///tmp/first%20image.png file:///tmp/second.jpg", {
				platform: "linux",
			}),
		).toEqual(["/tmp/first image.png", "/tmp/second.jpg"]);
		expect(
			decodePastedPathCandidates("file:///tmp/first.png file://server/share/second.jpg", {
				platform: "linux",
			}),
		).toBeUndefined();
	});

	it("rejects empty input, empty candidates, and unfinished tokenizer states", () => {
		expect(decodePastedPathCandidates(" \t\r\n")).toBeUndefined();
		expect(decodePastedPathCandidates("first.png '' second.png")).toBeUndefined();
		expect(decodePastedPathCandidates("first.png 'second.png")).toBeUndefined();
		expect(decodePastedPathCandidates('first.png "second.png')).toBeUndefined();
		expect(decodePastedPathCandidates("first.png second.png\\", { platform: "linux" })).toBeUndefined();
	});
});

describe("formatPastedImageReference", () => {
	it("keeps the image placeholder while preserving the exact source path", () => {
		const imagePath = `/tmp/Screenshot 2026-07-09 at 10.00.00${NNBSP}PM.png`;
		expect(formatPastedImageReference("[image 1]", imagePath)).toBe(
			`[image 1] source="/tmp/Screenshot 2026-07-09 at 10.00.00${NNBSP}PM.png"`,
		);
	});

	it("JSON-escapes paths so spaces, quotes, and backslashes stay model-readable", () => {
		expect(formatPastedImageReference("[image 2]", String.raw`C:\Users\me\shot "final".png`)).toBe(
			String.raw`[image 2] source="C:\\Users\\me\\shot \"final\".png"`,
		);
	});
});

describe("decodePastedPathCandidate (win32 contract)", () => {
	it("decodes drive-letter file:// URIs to win32 paths", () => {
		expect(decodePastedPathCandidate("file:///C:/Users/me/Pictures/shot.png", { platform: "win32" })).toBe(
			"C:\\Users\\me\\Pictures\\shot.png",
		);
	});

	it("decodes file://localhost drive-letter URIs", () => {
		expect(decodePastedPathCandidate("file://localhost/C:/x.png", { platform: "win32" })).toBe("C:\\x.png");
	});

	it("decodes UNC-host file:// URIs", () => {
		expect(decodePastedPathCandidate("file://server/share/img.png", { platform: "win32" })).toBe(
			"\\\\server\\share\\img.png",
		);
	});

	it("decodes percent-encoded spaces in win32 file:// URIs", () => {
		expect(decodePastedPathCandidate("file:///C:/My%20Pictures/shot.png", { platform: "win32" })).toBe(
			"C:\\My Pictures\\shot.png",
		);
	});

	it("rejects drive-letter-less file:// URIs on win32", () => {
		expect(decodePastedPathCandidate("file:///Users/me/shot.png", { platform: "win32" })).toBeUndefined();
	});

	it("rejects encoded path separators", () => {
		expect(decodePastedPathCandidate("file:///C:/a%2Fb.png", { platform: "win32" })).toBeUndefined();
		expect(decodePastedPathCandidate("file:///C:/a%5Cb.png", { platform: "win32" })).toBeUndefined();
	});

	it("does not shell-unescape win32 paths (backslash is the separator)", () => {
		expect(decodePastedPathCandidate("C:\\Users\\me\\img.png", { platform: "win32" })).toBe("C:\\Users\\me\\img.png");
	});
});

describe("decodePastedPathCandidate (posix contract)", () => {
	it("rejects file:// URIs with non-localhost hosts", () => {
		expect(decodePastedPathCandidate("file://server/share/img.png", { platform: "linux" })).toBeUndefined();
	});

	it("rejects encoded path separators", () => {
		expect(decodePastedPathCandidate("file:///tmp/a%2Fb.png", { platform: "linux" })).toBeUndefined();
	});
});
