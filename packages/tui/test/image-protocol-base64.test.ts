import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Image } from "@gajae-code/tui/components/image";
import {
	encodeITerm2,
	encodeKitty,
	encodeKittyTransmission,
	encodeKittyTransmit,
	ImageProtocol,
	renderImage,
	resetKittyTransmissions,
	setKittyTransmitWriter,
	TERMINAL,
} from "@gajae-code/tui/terminal-capabilities";
import fc from "fast-check";

const PROPERTY_SEED = 412;
const PROPERTY_RUNS = 64;
const DIMS = { widthPx: 100, heightPx: 100 };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

type MutableTerminal = { imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminal;

function kittyPayload(encoded: string): string {
	const parts: string[] = [];
	let rest = encoded;
	while (rest.length > 0) {
		const terminator = rest.indexOf("\x1b\\");
		expect(terminator).toBeGreaterThan(0);
		const frame = rest.slice(0, terminator);
		expect(frame.startsWith("\x1b_G")).toBe(true);
		expect(frame.includes("\x07")).toBe(false);
		parts.push(frame.slice(frame.indexOf(";") + 1));
		rest = rest.slice(terminator + 2);
	}
	return parts.join("");
}

describe("image protocol base64 guard", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let written: string[];

	beforeEach(() => {
		resetKittyTransmissions();
		written = [];
		setKittyTransmitWriter(sequence => {
			written.push(sequence);
		});
	});

	afterEach(() => {
		terminal.imageProtocol = originalProtocol;
		resetKittyTransmissions();
		setKittyTransmitWriter(sequence => {
			process.stdout.write(sequence);
		});
	});

	it("Image and renderImage drop a kitty payload that ends the APC early", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const injected = `AAAA\x1b\\\x1b]52;c;${Buffer.from("owned").toString("base64")}\x07`;
		const image = new Image(injected, "image/png", { fallbackColor: text => text }, { maxWidthCells: 10 }, DIMS);
		const lines = image.render(40).join("\n");
		expect(lines).toContain("[image/png");
		expect(lines).not.toContain("\x1b]52");
		expect(written.join("")).not.toContain("\x1b]52");
		expect(renderImage(injected, DIMS, { maxWidthCells: 10, maxHeightCells: 2 })).toBeNull();
		expect(() => encodeKitty(injected)).toThrow("Invalid RFC 4648 base64");
		expect(() => encodeKittyTransmit(injected, 1)).toThrow("Invalid RFC 4648 base64");
	});

	it("renderImage drops an iTerm2 payload that ends the OSC early", () => {
		terminal.imageProtocol = ImageProtocol.Iterm2;
		const injected = "AAAA\x07\x1b]0;pwned\x07\x1b]52;c;QQ==\x07";
		const image = new Image(injected, "image/png", { fallbackColor: text => text }, { maxWidthCells: 10 }, DIMS);
		const lines = image.render(40).join("\n");
		expect(lines).toContain("[image/png");
		expect(lines).not.toContain("\x1b]0;");
		expect(lines).not.toContain("\x1b]52");
		expect(renderImage(injected, DIMS, { maxWidthCells: 10, maxHeightCells: 2 })).toBeNull();
		expect(() => encodeITerm2(injected)).toThrow("Invalid RFC 4648 base64");
	});

	it("still allows a padded PNG through renderImage for kitty and iterm2", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const kitty = renderImage(PNG, DIMS, { maxWidthCells: 4, maxHeightCells: 2 });
		expect(kitty).not.toBeNull();
		expect(kitty?.sequence).toContain("a=p");
		expect(written.join("")).toContain(PNG);
		expect(written.join("")).not.toContain("\x1b]52");
		const kittyImage = new Image(PNG, "image/png", { fallbackColor: text => text }, { maxWidthCells: 4 }, DIMS);
		expect(kittyImage.render(20).join("\n")).toContain("\x1b_G");

		terminal.imageProtocol = ImageProtocol.Iterm2;
		const iterm = renderImage(PNG, DIMS, { maxWidthCells: 4, maxHeightCells: 2 });
		expect(iterm?.sequence).toContain(PNG);
		expect(iterm?.sequence.endsWith("\x07")).toBe(true);
		expect(iterm?.sequence.slice(0, -1).includes("\x07")).toBe(false);
		expect(iterm?.sequence.includes("\x1b\\")).toBe(false);
		const itermImage = new Image(PNG, "image/png", { fallbackColor: text => text }, { maxWidthCells: 4 }, DIMS);
		expect(itermImage.render(20).join("")).toContain(PNG);
	});

	it("still allows an empty base64 image payload", () => {
		expect(encodeKittyTransmission("a=t,f=100,q=2,i=1", "")).toBe("\x1b_Ga=t,f=100,q=2,i=1;\x1b\\");
		const iterm = encodeITerm2("");
		expect(iterm.endsWith(":\x07")).toBe(true);
		expect(iterm.includes("\x1b")).toBe(true);
		expect(iterm.slice(1).includes("\x1b")).toBe(false);
	});

	it("still allows a 12 MiB padded base64 payload", () => {
		const payload = Buffer.alloc(12 * 1024 * 1024).toString("base64");
		expect(payload.length % 4).toBe(0);
		const iterm = encodeITerm2(payload, { width: 1, height: "auto" });
		expect(iterm.endsWith(`${payload}\x07`)).toBe(true);
		expect(kittyPayload(encodeKittyTransmit(payload, 1))).toBe(payload);
		terminal.imageProtocol = ImageProtocol.Iterm2;
		const itermRender = renderImage(payload, DIMS, { maxWidthCells: 2, maxHeightCells: 2 });
		expect(itermRender?.sequence.endsWith(`${payload}\x07`)).toBe(true);
		terminal.imageProtocol = ImageProtocol.Kitty;
		resetKittyTransmissions();
		written.length = 0;
		const kittyRender = renderImage(payload, DIMS, { maxWidthCells: 2, maxHeightCells: 2 });
		expect(kittyRender).not.toBeNull();
		expect(written.join("")).toContain(payload.slice(0, 16));
		expect(written.join("")).not.toContain("\x1b]52");
	}, 30_000);

	it("renderImage drops a BEL appended to a 12 MiB payload", () => {
		const payload = `${Buffer.alloc(12 * 1024 * 1024)
			.toString("base64")
			.slice(0, -1)}\u0007`;
		expect(() => encodeITerm2(payload)).toThrow("Invalid RFC 4648 base64");
		expect(() => encodeKittyTransmit(payload, 1)).toThrow("Invalid RFC 4648 base64");
		terminal.imageProtocol = ImageProtocol.Iterm2;
		expect(renderImage(payload, DIMS, { maxWidthCells: 2, maxHeightCells: 2 })).toBeNull();
		terminal.imageProtocol = ImageProtocol.Kitty;
		written.length = 0;
		expect(renderImage(payload, DIMS, { maxWidthCells: 2, maxHeightCells: 2 })).toBeNull();
		expect(written).toEqual([]);
	}, 30_000);

	it("still allows AA== and AAA= padding forms", () => {
		expect(kittyPayload(encodeKittyTransmit("AA==", 4))).toBe("AA==");
		expect(kittyPayload(encodeKitty("AAA=", { columns: 1, rows: 1 }))).toBe("AAA=");
		expect(encodeITerm2("AAA=", { width: "auto", height: "auto" })).toContain(":AAA=\x07");
	});

	it("property: short strings follow the RFC 4648 alphabet, seed 412, 64 inputs", () => {
		const reference = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
		fc.assert(
			fc.property(fc.string({ maxLength: 32 }), value => {
				const accepted = value.length % 4 === 0 && reference.test(value);
				if (accepted) {
					expect(encodeITerm2(value).endsWith(`${value}\x07`)).toBe(true);
					expect(kittyPayload(encodeKittyTransmit(value, 1))).toBe(value);
				} else {
					expect(() => encodeITerm2(value)).toThrow("Invalid RFC 4648 base64");
					expect(() => encodeKittyTransmit(value, 1)).toThrow("Invalid RFC 4648 base64");
				}
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: still allows RFC 4648 image bytes inside kitty and iterm2 escapes, seed 412, 64 inputs", () => {
		fc.assert(
			fc.property(fc.uint8Array({ minLength: 0, maxLength: 5000 }), bytes => {
				const payload = Buffer.from(bytes).toString("base64");
				const header = "a=t,f=100,q=2,i=7";
				const kitty = encodeKittyTransmission(header, payload);
				expect(kitty.replace(/\x1b_G[^\x1b]*\x1b\\/gu, "")).toBe("");
				expect(kittyPayload(kitty)).toBe(payload);
				expect(encodeKittyTransmission(header, payload)).toBe(kitty);
				expect(kittyPayload(encodeKitty(payload, { columns: 2, rows: 2, imageId: 7, placementId: 3 }))).toBe(
					payload,
				);
				expect(kittyPayload(encodeKittyTransmit(payload, 7))).toBe(payload);
				const iterm = encodeITerm2(payload, { width: 2, height: "auto", inline: true });
				expect(iterm.endsWith(`:${payload}\x07`)).toBe(true);
				expect(iterm.slice(0, -1).includes("\x07")).toBe(false);
				expect(iterm.includes("\x1b\\")).toBe(false);
				expect(encodeITerm2(payload, { width: 2, height: "auto", inline: true })).toBe(iterm);
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: image encoders drop an early APC or OSC terminator, seed 412, 64 inputs", () => {
		fc.assert(
			fc.property(
				fc.uint8Array({ minLength: 0, maxLength: 32 }),
				fc.constantFrom("\u0007", "\u001b\\", "\u001b", "\n", " ", "-", "_", "\u0000"),
				fc.integer({ min: 0, max: 16 }),
				(bytes, terminator, at) => {
					const base = Buffer.from(bytes).toString("base64");
					const index = base.length === 0 ? 0 : at % (base.length + 1);
					const payload = base.slice(0, index) + terminator + base.slice(index);
					written.length = 0;
					expect(() => encodeKittyTransmission("a=t,f=100,q=2,i=1", payload)).toThrow("Invalid RFC 4648 base64");
					expect(() => encodeKitty(payload)).toThrow("Invalid RFC 4648 base64");
					expect(() => encodeKittyTransmit(payload, 1)).toThrow("Invalid RFC 4648 base64");
					expect(() => encodeITerm2(payload)).toThrow("Invalid RFC 4648 base64");
					terminal.imageProtocol = ImageProtocol.Kitty;
					expect(renderImage(payload, DIMS, { maxWidthCells: 8, maxHeightCells: 4 })).toBeNull();
					terminal.imageProtocol = ImageProtocol.Iterm2;
					expect(renderImage(payload, DIMS, { maxWidthCells: 8, maxHeightCells: 4 })).toBeNull();
					expect(written).toEqual([]);
				},
			),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});
});
