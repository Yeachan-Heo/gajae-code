import { describe, expect, it } from "bun:test";

import { ComputerController, computerScreenshot } from "../native/index.js";

const isMacOS = process.platform === "darwin";
const SCREEN_RECORDING_PERMISSION_ERROR = "screen capture failed; the Screen Recording permission may not be granted";

function isScreenRecordingPermissionError(error: unknown): boolean {
	return error instanceof Error && error.message === SCREEN_RECORDING_PERMISSION_ERROR;
}

describe.if(isMacOS)("ComputerController napi binding", () => {
	it("exists with expected methods", () => {
		const controller = new ComputerController();
		expect(controller).toBeInstanceOf(ComputerController);
		const methods = [
			"screenshot",
			"click",
			"doubleClick",
			"move",
			"drag",
			"scroll",
			"type",
			"keypress",
			"wait",
			"gate0PermissionStatus",
			"gate0RequestScreenRecording",
			"gate0HarmlessProbe",
		] as const;
		for (const method of methods) {
			expect(typeof controller[method]).toBe("function");
		}
	});

	it("returns the redacted Gate-0 permission-status shape without prompting", () => {
		const controller = new ComputerController();
		const status = controller.gate0PermissionStatus();
		expect(status).toEqual({
			accessibility: expect.any(Boolean),
			screenRecording: expect.any(Boolean),
		});
	});

	it("returns only the redacted harmless-probe shape", () => {
		const controller = new ComputerController();
		const status = controller.gate0PermissionStatus();
		const probe = controller.gate0HarmlessProbe();

		expect(probe).toEqual({
			screenshot: expect.any(Boolean),
			accessibility: expect.any(Boolean),
			pointerMoveRestore: expect.any(Boolean),
		});
		expect(probe.accessibility).toBe(status.accessibility);
		if (status.screenRecording) {
			expect(probe.screenshot).toBe(true);
		}
		if (status.accessibility) {
			expect(probe.pointerMoveRestore).toBe(true);
		}
	});
});
// The native `computerScreenshot` binding is macOS-only and captures the real
// primary display, so only its exact missing-permission error is skipped.
describe.if(isMacOS)("computer screenshot napi binding", () => {
	it("returns a decodable PNG whose dimensions match the descriptor", () => {
		let shot: ReturnType<typeof computerScreenshot>;
		try {
			shot = computerScreenshot();
		} catch (err) {
			if (isScreenRecordingPermissionError(err)) {
				return;
			}
			throw err;
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
