import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import {
	decodePastedPathCandidate,
	decodePastedPathCandidates,
	formatPastedImageReference,
	MAX_PASTED_IMAGE_COUNT,
	MAX_PASTED_IMAGE_PATH_CHARACTERS,
	parsePastedImagePaths,
	resolvePastedImagePath,
} from "../src/utils/pasted-image-path";

const NNBSP = "\u202f";

describe("resolvePastedImagePath", () => {
	it("keeps ordinary single saved paths literal", () => {
		expect(resolvePastedImagePath("/tmp/plain.png")).toBeUndefined();
		expect(resolvePastedImagePath("'/tmp/quoted image.jpg'")).toBeUndefined();
		expect(resolvePastedImagePath("~/home.webp", { homedir: "/tmp/home" })).toBeUndefined();
	});

	it("recognizes clipboard-temp policy before filesystem access", () => {
		const missing = path.join(os.tmpdir(), "clipboard-2026-07-19-123456-Ab3.png");
		expect(resolvePastedImagePath(missing)).toBe(missing);
	});

	it("accepts terminal line endings but rejects non-path multiline text", () => {
		const clipboard = path.join(os.tmpdir(), "clipboard-2026-07-19-123456-Ab3.png");
		expect(resolvePastedImagePath(clipboard.replace(/\.png$/, ".txt"))).toBeUndefined();
		expect(resolvePastedImagePath(`look at ${clipboard}`)).toBeUndefined();
		expect(resolvePastedImagePath(`${clipboard}\nmore`)).toBeUndefined();
		expect(resolvePastedImagePath("   ")).toBeUndefined();
		expect(resolvePastedImagePath(`${clipboard} please`)).toBeUndefined();
		expect(resolvePastedImagePath(`\n${clipboard}`)).toBeUndefined();
		expect(resolvePastedImagePath(`${clipboard}\n`)).toBe(clipboard);
		expect(resolvePastedImagePath(`${clipboard}\r\n`)).toBe(clipboard);
		expect(resolvePastedImagePath(`"${clipboard}"`)).toBe(clipboard);
		expect(resolvePastedImagePath(`./${path.basename(clipboard)}`, { cwd: os.tmpdir() })).toBe(clipboard);
	});

	it("rejects remote Windows paths before attachment policy", () => {
		expect(
			resolvePastedImagePath(String.raw`\\server\share\clipboard-2026-07-19-123456-Ab3.png`, {
				platform: "win32",
			}),
		).toBeUndefined();
		expect(
			resolvePastedImagePath("file://server/share/clipboard-2026-07-19-123456-Ab3.png", {
				platform: "win32",
			}),
		).toBeUndefined();
	});
});

describe("parsePastedImagePaths", () => {
	it("parses the exact macOS multi-screenshot shape in source order", () => {
		const first = `/Users/me/Desktop/Screenshot 2026-07-19 at 3.21.27${NNBSP}PM.png`;
		const second = `/Users/me/Desktop/Screenshot 2026-07-19 at 3.21.29${NNBSP}PM.png`;
		const paste = `${first.replaceAll(" ", "\\ ")} ${second.replaceAll(" ", "\\ ")}`;
		expect(parsePastedImagePaths(paste)).toEqual({
			kind: "paths",
			paths: [first, second],
			requiresConfirmation: true,
		});
	});

	it("supports quoted, escaped, relative, home-relative, and newline-separated paths", () => {
		const parsed = parsePastedImagePaths(`./first\\ image.png\n'~/second image.jpg'`, {
			cwd: "/workspace",
			homedir: "/home/me",
			platform: "linux",
		});
		expect(parsed).toEqual({
			kind: "paths",
			paths: ["/workspace/first image.png", "/home/me/second image.jpg"],
			requiresConfirmation: true,
		});
	});

	it("supports complete lists of local file URLs", () => {
		const first = "/tmp/first uri.png";
		const second = "/tmp/second uri.jpg";
		const paste = `${url.pathToFileURL(first).href}\n${url.pathToFileURL(second).href}`;
		expect(parsePastedImagePaths(paste)).toEqual({
			kind: "paths",
			paths: [first, second],
			requiresConfirmation: true,
		});
	});

	it("retains automatic handling only for a single clipboard-temp path", () => {
		const clipboard = path.join(os.tmpdir(), "clipboard-2026-07-19-123456-Ab3.png");
		expect(parsePastedImagePaths(clipboard)).toEqual({
			kind: "paths",
			paths: [clipboard],
			requiresConfirmation: false,
		});
		expect(parsePastedImagePaths("/tmp/saved.png")).toBeUndefined();
	});

	it("rejects prose around clipboard paths as an incomplete payload", () => {
		const clipboard = path.join(os.tmpdir(), "clipboard-2026-07-19-123456-Ab3.png");
		const paths = Array.from({ length: MAX_PASTED_IMAGE_COUNT }, (_, index) => `/tmp/${index}.png`);

		expect(parsePastedImagePaths(`look at ${clipboard}`)).toBeUndefined();
		expect(parsePastedImagePaths(`${paths.join(" ")} look at ${clipboard}`)).toBeUndefined();
	});

	it("stops at the count bound before accepting candidate 17", () => {
		const paste = Array.from({ length: MAX_PASTED_IMAGE_COUNT + 1 }, (_, index) => `/tmp/${index}.png`).join(" ");
		expect(parsePastedImagePaths(paste)).toEqual({
			kind: "too-many",
			maxCandidates: MAX_PASTED_IMAGE_COUNT,
		});
	});

	it("does not classify ordinary over-token text as an image overflow", () => {
		expect(parsePastedImagePaths(Array.from({ length: 17 }, (_, index) => `word${index}`).join(" "))).toBeUndefined();
	});

	it("rejects an oversized candidate before retaining the complete token", () => {
		const oversized = `/tmp/${"a".repeat(MAX_PASTED_IMAGE_PATH_CHARACTERS)}.png /tmp/second.png`;
		expect(parsePastedImagePaths(oversized)).toBeUndefined();
	});

	it("rejects malformed lists, prose, unsupported extensions, and empty candidates", () => {
		expect(parsePastedImagePaths("'/tmp/first.png /tmp/second.png")).toBeUndefined();
		expect(parsePastedImagePaths("/tmp/first.png prose")).toBeUndefined();
		expect(parsePastedImagePaths("/tmp/first.png /tmp/second.txt")).toBeUndefined();
		expect(parsePastedImagePaths("/tmp/first.png '' /tmp/second.png")).toBeUndefined();
		expect(parsePastedImagePaths("/tmp/first.png /tmp/second.png\\", { platform: "linux" })).toBeUndefined();
	});

	it("rejects remote file hosts and UNC members before any attachment I/O", () => {
		expect(
			parsePastedImagePaths("C:\\one.png file://server/share/two.png", {
				platform: "win32",
				cwd: "C:\\",
			}),
		).toBeUndefined();
		expect(
			parsePastedImagePaths(String.raw`C:\one.png \\server\share\two.png`, {
				platform: "win32",
				cwd: "C:\\",
			}),
		).toBeUndefined();
	});
});

describe("decodePastedPathCandidates", () => {
	it("uses only ASCII whitespace as separators and preserves Windows backslashes", () => {
		expect(decodePastedPathCandidates(`first${NNBSP}image.png\tsecond.jpg`)).toEqual([
			`first${NNBSP}image.png`,
			"second.jpg",
		]);
		expect(
			decodePastedPathCandidates(String.raw`C:\Users\me\one.png "D:\Saved Images\two.jpg"`, {
				platform: "win32",
			}),
		).toEqual([String.raw`C:\Users\me\one.png`, String.raw`D:\Saved Images\two.jpg`]);
	});

	it("returns undefined when the configured lexical count bound is exceeded", () => {
		expect(decodePastedPathCandidates("one.png two.png three.png", {}, 2)).toBeUndefined();
	});
});

describe("decodePastedPathCandidate platform contracts", () => {
	it("decodes drive-letter, localhost, and UNC file URLs for explicit callers", () => {
		expect(decodePastedPathCandidate("file:///C:/Users/me/shot.png", { platform: "win32" })).toBe(
			"C:\\Users\\me\\shot.png",
		);
		expect(decodePastedPathCandidate("file://localhost/C:/x.png", { platform: "win32" })).toBe("C:\\x.png");
		expect(decodePastedPathCandidate("file://server/share/img.png", { platform: "win32" })).toBe(
			"\\\\server\\share\\img.png",
		);
	});

	it("rejects invalid foreign-platform file URLs", () => {
		expect(decodePastedPathCandidate("file:///Users/me/shot.png", { platform: "win32" })).toBeUndefined();
		expect(decodePastedPathCandidate("file:///C:/a%2Fb.png", { platform: "win32" })).toBeUndefined();
		expect(decodePastedPathCandidate("file://server/share/img.png", { platform: "linux" })).toBeUndefined();
	});
});

describe("formatPastedImageReference", () => {
	it("preserves and JSON-escapes source paths", () => {
		expect(formatPastedImageReference("[image 2]", String.raw`C:\Users\me\shot "final".png`)).toBe(
			String.raw`[image 2] source="C:\\Users\\me\\shot \"final\".png"`,
		);
	});
});
