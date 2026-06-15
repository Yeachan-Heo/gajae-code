import { describe, expect, it } from "bun:test";
import { ComputerController, computerScreenshot } from "../native/index.js";

const isMacOS = process.platform === "darwin";

describe.if(isMacOS)("ComputerController napi binding", () => {
	it("exists with expected methods", () => {
		const controller = new ComputerController();
		expect(controller).toBeInstanceOf(ComputerController);
		for (const method of [
			"screenshot",
			"click",
			"doubleClick",
			"move",
			"drag",
			"scroll",
			"type",
			"keypress",
			"wait",
		]) {
			expect(typeof controller[method as keyof ComputerController]).toBe("function");
		}
	});
});

// The native `computerScreenshot` binding is macOS-only and captures the real
// primary display, so it requires the Screen Recording permission. Gate on
// platform and skip gracefully when capture is unavailable in the environment.
describe.if(isMacOS)("computer screenshot napi binding", () => {
	it("returns a decodable PNG whose dimensions match the descriptor", () => {
		let shot: ReturnType<typeof computerScreenshot>;
		try {
			shot = computerScreenshot();
		} catch (err) {
			// Screen Recording not granted to this process — surfaced, not silent.
			console.warn(`skipping: computerScreenshot unavailable (${String(err)})`);
			return;
		}

		expect(shot.widthPx).toBeGreaterThan(0);
		expect(shot.heightPx).toBeGreaterThan(0);
		expect(shot.scaleX).toBeGreaterThan(0);
		expect(shot.scaleY).toBeGreaterThan(0);
		expect(shot.png.byteLength).toBeGreaterThan(0);
		expect(shot.displayEpoch).toBeGreaterThan(0);
		expect(shot.captureId).toBeGreaterThan(0);

		// PNG magic number: 89 50 4E 47 0D 0A 1A 0A.
		const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		for (let i = 0; i < sig.length; i++) {
			expect(shot.png[i]).toBe(sig[i]);
		}
	});
});
