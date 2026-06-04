import { afterEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@gajae-code/utils";
import { resetFullCaptureEnvWarningForTest, warnIfEnvFullContentCaptureActive } from "../src/sdk";

describe("full content capture env warning", () => {
	const envName = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

	afterEach(() => {
		delete process.env[envName];
		resetFullCaptureEnvWarningForTest();
		vi.restoreAllMocks();
	});

	it("warns once through the telemetry hook and logger when env full capture is active", () => {
		process.env[envName] = "full";
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const hook = vi.fn();

		warnIfEnvFullContentCaptureActive({ onTelemetryWarning: hook });
		warnIfEnvFullContentCaptureActive({ onTelemetryWarning: hook });

		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook.mock.calls[0]?.[0]).toMatchObject({ code: "full_content_capture_env_active" });
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toContain(`${envName}=full enables full GenAI message content capture`);
	});

	it("does not warn for env summary capture or explicit programmatic full capture", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const hook = vi.fn();

		process.env[envName] = "summary";
		warnIfEnvFullContentCaptureActive({ onTelemetryWarning: hook });

		process.env[envName] = "full";
		warnIfEnvFullContentCaptureActive({ captureMessageContent: true, onTelemetryWarning: hook });

		expect(hook).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
