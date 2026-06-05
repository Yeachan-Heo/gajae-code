import { afterEach, describe, expect, it, vi } from "bun:test";
import { resetContentCaptureEnvCacheForTest, resolveTelemetry } from "@gajae-code/agent-core/telemetry";

describe("full content capture env warning", () => {
	const envName = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

	afterEach(() => {
		delete process.env[envName];
		resetContentCaptureEnvCacheForTest();
		vi.restoreAllMocks();
	});

	it("warns once through the telemetry hook when env full capture is active", () => {
		process.env[envName] = "full";
		const hook = vi.fn();

		resolveTelemetry({ onTelemetryWarning: hook }, "session-1");
		resolveTelemetry({ onTelemetryWarning: hook }, "session-1");

		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook.mock.calls[0]?.[0]).toMatchObject({
			code: "full_content_capture_env_active",
			message: `${envName}=full enables full GenAI message content capture. Use ${envName}=summary for bounded telemetry summaries.`,
		});
	});

	it("does not warn for env summary capture or explicit programmatic full capture", () => {
		const hook = vi.fn();

		process.env[envName] = "summary";
		resolveTelemetry({ onTelemetryWarning: hook }, "session-1");

		process.env[envName] = "full";
		resetContentCaptureEnvCacheForTest();
		resolveTelemetry({ captureMessageContent: true, onTelemetryWarning: hook }, "session-1");

		expect(hook).not.toHaveBeenCalled();
	});
});
