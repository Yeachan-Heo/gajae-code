import { describe, expect, it } from "bun:test";
import { classifyProviderRetry, classifyProviderRetryFromTransport } from "../../src/task/provider-retry-status";

describe("classifyProviderRetry", () => {
	it("classifies canonical first-event timeout prose", () => {
		for (const message of [
			"Provider stream timed out while waiting for the first event",
			"Anthropic stream timed out while waiting for the first event",
			"Error: Provider stream timed out while waiting for the first event",
		]) {
			expect(classifyProviderRetry(message)).toBe("first_event_timeout");
		}
	});

	it("classifies only the exact no-the first-event compatibility message", () => {
		expect(classifyProviderRetry("Provider stream timed out while waiting for first event")).toBe(
			"first_event_timeout",
		);
		for (const message of [
			"Error: Provider stream timed out while waiting for first event",
			"Provider stream timed out while waiting for first event.",
			"Provider stream timeout waiting for first event",
		]) {
			expect(classifyProviderRetry(message)).toBe("provider_error");
		}
	});

	it("classifies idle stalls from message prose", () => {
		expect(classifyProviderRetry("Provider stream stalled while waiting for the next event")).toBe(
			"idle_stream_stall",
		);
	});

	it("defaults other messages to provider_error", () => {
		expect(classifyProviderRetry("rate limited")).toBe("provider_error");
	});
});

describe("classifyProviderRetryFromTransport", () => {
	it("prefers stream_first_event_timeout providerCode over message prose", () => {
		expect(
			classifyProviderRetryFromTransport({
				providerCode: "stream_first_event_timeout",
				errorMessage: "something else entirely",
			}),
		).toBe("first_event_timeout");
	});

	it("is case-insensitive for providerCode", () => {
		expect(
			classifyProviderRetryFromTransport({
				providerCode: "STREAM_FIRST_EVENT_TIMEOUT",
			}),
		).toBe("first_event_timeout");
	});

	it("keeps typed first-event authority over incompatible prose", () => {
		expect(
			classifyProviderRetryFromTransport({
				providerCode: "stream_first_event_timeout",
				errorMessage: "Provider stream timed out while waiting for first event.",
			}),
		).toBe("first_event_timeout");
	});

	it("falls back to message classification when providerCode is absent", () => {
		expect(
			classifyProviderRetryFromTransport({
				errorMessage: "Provider stream timed out while waiting for the first event",
			}),
		).toBe("first_event_timeout");
		expect(
			classifyProviderRetryFromTransport({
				errorMessage: "Provider stream timed out while waiting for first event",
			}),
		).toBe("first_event_timeout");
		expect(
			classifyProviderRetryFromTransport({
				errorMessage: "Provider stream stalled while waiting for the next event",
			}),
		).toBe("idle_stream_stall");
		expect(classifyProviderRetryFromTransport({ errorMessage: "boom" })).toBe("provider_error");
	});

	it("falls back to message classification when providerCode is not the first-event fact", () => {
		expect(
			classifyProviderRetryFromTransport({
				providerCode: "rate_limit_error",
				errorMessage: "Provider stream timed out while waiting for the first event",
			}),
		).toBe("first_event_timeout");
		expect(
			classifyProviderRetryFromTransport({
				providerCode: "rate_limit_error",
				errorMessage: "rate limited",
			}),
		).toBe("provider_error");
	});
});
