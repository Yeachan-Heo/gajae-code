import { afterEach, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { Image } from "../src/components/image.js";
import { imageFallback, setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities.js";

const PROPERTY_SEED = 64503;
const PROPERTY_RUNS = 64;
const DIMS = { widthPx: 10, heightPx: 8 };
const OSC52 = "\x1b]52;c;QQ==\x07";
const OSC_TITLE = "\x1b]0;pwned\x07";
const DCS = "\x1bPpayload\x1b\\";
const PRINTABLE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._-/\\()사진";

function hasControl(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 0x09) continue;
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

function paint(filename: string, mimeType = "image/png"): string {
	setTerminalImageProtocol(null);
	const image = new Image("AA==", mimeType, { fallbackColor: text => `\x1b[33m${text}\x1b[0m` }, { filename }, DIMS);
	return image.render(40).join("\n");
}

describe("image fallback filename", () => {
	const previousProtocol = TERMINAL.imageProtocol;
	afterEach(() => {
		setTerminalImageProtocol(previousProtocol);
	});

	it("imageFallback emits OSC 52, a title OSC, and DCS from a hostile filename", () => {
		const line = imageFallback("image/png", DIMS, `shot${OSC52}${OSC_TITLE}${DCS}.png`);
		expect(line).toBe("[Image: shot.png [image/png] 10x8]");
		expect(line.includes("\x1b]52")).toBe(false);
		expect(line.includes("\x1b]0;")).toBe(false);
		expect(line.includes("\x1bP")).toBe(false);
		expect(line.includes("\x07")).toBe(false);
		expect(hasControl(line)).toBe(false);
	});

	it("Image render emits a title OSC from a hostile filename", () => {
		const line = paint(`shot${OSC_TITLE}.png`);
		expect(line.includes("\x1b]0;")).toBe(false);
		expect(line.includes("\x1b]52")).toBe(false);
		expect(line).toContain("\x1b[33m");
		expect(line).toContain("shot.png");
		expect(line).toContain("[image/png]");
		expect(line.split("\n")).toHaveLength(1);
	});

	it("imageFallback emits C1 and DCS from a media type", () => {
		const line = imageFallback(`image/png${DCS}\x9b31m`, DIMS);
		expect(line).toBe("[Image: [image/png] 10x8]");
		expect(line.includes("\x1bP")).toBe(false);
		expect(line.includes("\x9b")).toBe(false);
		expect(hasControl(line)).toBe(false);
	});

	it("imageFallback stays on one row when the filename contains a newline", () => {
		const line = imageFallback("image/png", DIMS, "shot.png\n\x1b]52;c;QQ==\x07next");
		expect(line.includes("\n")).toBe(false);
		expect(line.includes("\x1b")).toBe(false);
		expect(line).toContain("shot.png");
		expect(line).toContain("next");
	});

	it("imageFallback drops directional marks from a filename", () => {
		const line = imageFallback("image/png", DIMS, "a\u202Ephoto.png");
		expect(line).toContain("aphoto.png");
		expect(line.includes("\u202E")).toBe(false);
	});

	it("keeps a plain filename, its letter case, and surrounding spaces", () => {
		expect(imageFallback("image/png", DIMS, "  My Photo.PNG  ")).toBe("[Image:   My Photo.PNG   [image/png] 10x8]");
		expect(imageFallback("image/svg+xml", DIMS, "사진.png")).toBe("[Image: 사진.png [image/svg+xml] 10x8]");
	});

	it("keeps a parent-directory name and a Windows path form", () => {
		expect(imageFallback("image/png", DIMS, "../images/photo.png")).toBe(
			"[Image: ../images/photo.png [image/png] 10x8]",
		);
		expect(imageFallback("image/png", DIMS, "C:\\images\\photo.png")).toBe(
			"[Image: C:\\images\\photo.png [image/png] 10x8]",
		);
	});

	it("keeps a tab in the filename and the media type", () => {
		expect(imageFallback("image/\tpng", DIMS, "a\tb.png")).toBe("[Image: a\tb.png [image/\tpng] 10x8]");
	});

	it("keeps an omitted filename and numeric dimensions", () => {
		expect(imageFallback("image/png", DIMS)).toBe("[Image: [image/png] 10x8]");
		expect(imageFallback("image/png", DIMS, "")).toBe("[Image: [image/png] 10x8]");
		expect(imageFallback("image/png")).toBe("[Image: [image/png]]");
	});

	it("keeps theme color the caller applies around a plain filename", () => {
		const line = paint("photo.png");
		expect(line.startsWith("\x1b[33m")).toBe(true);
		expect(line.endsWith("\x1b[0m")).toBe(true);
		expect(line).toContain("[Image: photo.png [image/png] 10x8]");
	});

	it("property: image fallback line has no controls, fc.property seed 64503, numRuns 64", () => {
		const control = fc.integer({ min: 0x00, max: 0x9f }).filter(code => code <= 0x1f || code >= 0x7f);
		fc.assert(
			fc.property(
				fc.string({ minLength: 0, maxLength: 24, unit: fc.constantFrom(...PRINTABLE) }),
				fc.array(control, { minLength: 0, maxLength: 6 }),
				(name, codes) => {
					const hostile = `${name}${codes.map(code => String.fromCharCode(code)).join("")}`;
					const line = imageFallback("image/png", DIMS, hostile);
					expect(hasControl(line)).toBe(false);
					expect(line.startsWith("[Image: ")).toBe(true);
					expect(line).toContain("[image/png]");
					expect(line).toContain("10x8");
					if (name.length > 0) expect(line).toContain(name);
				},
			),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: printable filenames stay unchanged, fc.property seed 64503, numRuns 64", () => {
		fc.assert(
			fc.property(fc.string({ minLength: 1, maxLength: 32, unit: fc.constantFrom(...PRINTABLE) }), name => {
				expect(imageFallback("image/png", DIMS, name)).toBe(`[Image: ${name} [image/png] 10x8]`);
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("scans a long filename once and retains the tail after an embedded OSC", () => {
		const filler = "a".repeat(80_000);
		const name = `${filler}${OSC52}${filler}`;
		const line = imageFallback("image/png", DIMS, name);
		expect(line).toBe(`[Image: ${filler}${filler} [image/png] 10x8]`);
		expect(line.includes("\x1b")).toBe(false);
		expect(line.includes("\x07")).toBe(false);
	});
});
