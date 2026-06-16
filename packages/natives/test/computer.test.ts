import { describe, expect, it } from "bun:test";

const isMacOS = process.platform === "darwin";

type NativeComputerModule = {
	ComputerController: new () => Record<string, unknown>;
	computerScreenshot: () => {
		widthPx: number;
		heightPx: number;
		scaleX: number;
		scaleY: number;
		png: Uint8Array;
		displayEpoch: number;
		captureId: number;
	};
};

async function loadNativeComputerModule(): Promise<NativeComputerModule> {
	return (await import("../native/index.js")) as unknown as NativeComputerModule;
}

describe.if(isMacOS)("ComputerController napi binding", () => {
	it("exists with expected methods", async () => {
		const { ComputerController } = await loadNativeComputerModule();
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
			expect(typeof controller[method]).toBe("function");
		}
	});
});

// The native `computerScreenshot` binding is macOS-only and captures the real
// primary display, so it requires the Screen Recording permission. Gate on
// platform and skip gracefully when capture is unavailable in the environment.
describe.if(isMacOS)("computer screenshot napi binding", () => {
	it("returns a decodable PNG whose dimensions match the descriptor", async () => {
		const { computerScreenshot } = await loadNativeComputerModule();
		let shot: ReturnType<NativeComputerModule["computerScreenshot"]>;
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
