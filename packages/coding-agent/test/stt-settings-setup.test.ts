import { describe, expect, it, vi } from "bun:test";
import { configureSttFromSettings, type SttDependencySetupOptions } from "../src/runtime/stt-settings-setup";

describe("STT settings setup", () => {
	it("configures missing dependencies when STT is enabled", async () => {
		const ensureDependencies = vi.fn(async (options?: SttDependencySetupOptions) => {
			options?.onProgress?.({ stage: "Installing openai-whisper", percent: 50 });
		});
		const setEnabled = vi.fn();
		const flush = vi.fn(async () => {});
		const showStatus = vi.fn();
		const showError = vi.fn();

		const ready = await configureSttFromSettings({
			modelName: "base.en",
			ensureDependencies,
			setEnabled,
			flush,
			showStatus,
			showError,
		});

		expect(ready).toBe(true);
		expect(ensureDependencies).toHaveBeenCalledTimes(1);
		expect(ensureDependencies.mock.calls[0]?.[0]?.modelName).toBe("base.en");
		expect(showStatus).toHaveBeenCalledWith("Checking speech-to-text dependencies...");
		expect(showStatus).toHaveBeenCalledWith("Installing openai-whisper (50%)");
		expect(showStatus).toHaveBeenLastCalledWith(
			"Speech-to-text is ready. Use /hotkeys or Ctrl+P → Toggle speech-to-text.",
		);
		expect(setEnabled).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});

	it("disables and persists STT when automatic setup fails", async () => {
		const setEnabled = vi.fn();
		const flush = vi.fn(async () => {});
		const showError = vi.fn();

		const ready = await configureSttFromSettings({
			ensureDependencies: async () => {
				throw new Error("Python not found");
			},
			setEnabled,
			flush,
			showStatus: () => {},
			showError,
		});

		expect(ready).toBe(false);
		expect(setEnabled).toHaveBeenCalledWith(false);
		expect(flush).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith(
			"Speech-to-text setup failed: Python not found. STT was disabled; fix the dependency and enable it again.",
		);
	});

	it("reports a durable rollback failure without hiding the setup error", async () => {
		const showError = vi.fn();

		const ready = await configureSttFromSettings({
			ensureDependencies: async () => {
				throw new Error("Whisper install failed");
			},
			setEnabled: () => {},
			flush: async () => {
				throw new Error("config write failed");
			},
			showStatus: () => {},
			showError,
		});

		expect(ready).toBe(false);
		expect(showError).toHaveBeenCalledWith(
			"Speech-to-text setup failed: Whisper install failed. Disabling STT also failed: config write failed",
		);
	});
});
