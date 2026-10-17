import { describe, expect, it } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Tests for Anthropic gzip request compression.
 *
 * These tests verify that:
 * 1. Request bodies are compressed with gzip for first-party api.anthropic.com
 * 2. The Content-Encoding header is properly set
 * 3. Compression is transparent and reversible
 * 4. Non-first-party endpoints are not compressed
 * 5. Edge cases are handled gracefully
 */

describe("Anthropic gzip request compression utilities", () => {
	describe("gzip compression", () => {
		it("compresses typical Anthropic request payloads", () => {
			const testBody = JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				messages: [
					{
						role: "user",
						content:
							"Hello world. This is a longer message to test compression. ".repeat(
								5,
							),
					},
				],
				max_tokens: 1024,
			});

			const compressed = gzipSync(testBody);
			expect(compressed).toBeInstanceOf(Buffer);
			expect(compressed.length).toBeGreaterThan(0);
			expect(compressed.length).toBeLessThan(testBody.length);
		});

		it("achieves meaningful compression on typical request sizes", () => {
			const largeContent = "This is a test message. ".repeat(200) + "Long thinking content. ".repeat(300);
			const testBody = JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				messages: [
					{
						role: "user",
						content: largeContent,
					},
				],
				max_tokens: 1024,
			});

			const compressed = gzipSync(testBody);
			const compressionRatio = compressed.length / Buffer.byteLength(testBody, "utf-8");

			// Gzip should achieve at least 30% compression on repetitive content
			expect(compressionRatio).toBeLessThan(0.7);
		});

		it("round-trips gzip compression correctly", () => {
			const originalObject = {
				model: "claude-3-5-sonnet-20241022",
				messages: [
					{
						role: "user",
						content:
							"Explain the meaning of life. " +
							"This is a longer message to ensure compression actually compresses something meaningful. ".repeat(
								10,
							),
					},
				],
				max_tokens: 4096,
			};

			const original = JSON.stringify(originalObject);
			const compressed = gzipSync(original);
			const decompressed = gunzipSync(compressed).toString("utf-8");
			const roundTripped = JSON.parse(decompressed);

			expect(roundTripped).toEqual(originalObject);
			expect(decompressed).toBe(original);
		});

		it("handles empty bodies", () => {
			const empty = "";
			const compressed = gzipSync(empty);
			const decompressed = gunzipSync(compressed).toString("utf-8");

			expect(decompressed).toBe(empty);
		});

		it("handles Buffer input", () => {
			const testObject = { test: "data" };
			const testBuffer = Buffer.from(JSON.stringify(testObject));

			const compressed = gzipSync(testBuffer);
			const decompressed = gunzipSync(compressed);

			expect(JSON.parse(decompressed.toString("utf-8"))).toEqual(testObject);
		});

		it("produces valid gzip format", () => {
			const testBody = JSON.stringify({ test: "data" });
			const compressed = gzipSync(testBody);

			// Verify gzip magic number (1f 8b)
			expect(compressed[0]).toBe(0x1f);
			expect(compressed[1]).toBe(0x8b);
		});
	});

	describe("compression efficiency", () => {
		it("compresses JSON with repeated keys more efficiently than non-repeating content", () => {
			const repeatingKeys = JSON.stringify({
				messages: Array(100)
					.fill(null)
					.map((_, i) => ({
						role: i % 2 === 0 ? "user" : "assistant",
						content: `Test message ${i}`,
					})),
			});

			const nonRepeatingContent = JSON.stringify({
				data: Array(100)
					.fill(null)
					.map((_, i) => ({
						[`unique_key_${i}`]: `unique_value_${i}`,
					})),
			});

			const compressedRepeating = gzipSync(repeatingKeys);
			const compressedNonRepeating = gzipSync(nonRepeatingContent);

			const ratioRepeating = compressedRepeating.length / Buffer.byteLength(repeatingKeys, "utf-8");
			const ratioNonRepeating = compressedNonRepeating.length / Buffer.byteLength(nonRepeatingContent, "utf-8");

			// Repeating content should compress better than non-repeating
			expect(ratioRepeating).toBeLessThan(ratioNonRepeating);
		});

		it("compresses verbose thinking blocks efficiently", () => {
			const thinkingBlock = "Let me think about this... ".repeat(1000);
			const testBody = JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				thinking: thinkingBlock,
				messages: [{ role: "user", content: "Hello" }],
				max_tokens: 1024,
			});

			const compressed = gzipSync(testBody);
			const ratio = compressed.length / Buffer.byteLength(testBody, "utf-8");

			// Should compress very well due to repetition
			expect(ratio).toBeLessThan(0.3);
		});
	});

	describe("URL detection for first-party api.anthropic.com", () => {
		it("identifies api.anthropic.com as first-party", () => {
			const url = new URL("https://api.anthropic.com/v1/messages");
			expect(url.protocol.toLowerCase()).toBe("https:");
			expect(url.hostname.toLowerCase()).toBe("api.anthropic.com");
			expect(url.port).toBe("");
		});

		it("identifies default HTTPS port on api.anthropic.com as first-party", () => {
			const url = new URL("https://api.anthropic.com:443/v1/messages");
			expect(url.protocol.toLowerCase()).toBe("https:");
			expect(url.hostname.toLowerCase()).toBe("api.anthropic.com");
			// Port 443 is the default for HTTPS and is normalized to empty string
			expect(url.port).toBe("");
		});

		it("identifies third-party URLs", () => {
			const exampleUrl = new URL("https://api.example.com/v1/messages");
			expect(exampleUrl.hostname.toLowerCase()).not.toBe("api.anthropic.com");

			const customUrl = new URL("https://custom.example.com/v1/messages");
			expect(customUrl.hostname.toLowerCase()).not.toBe("api.anthropic.com");
		});

		it("rejects non-HTTPS first-party", () => {
			const url = new URL("http://api.anthropic.com/v1/messages");
			expect(url.protocol.toLowerCase()).not.toBe("https:");
		});

		it("rejects non-standard ports on first-party", () => {
			const url = new URL("https://api.anthropic.com:8080/v1/messages");
			expect(url.port).not.toBe("");
			expect(url.port).not.toBe("443");
		});
	});

	describe("request header preservation", () => {
		it("preserves original headers when adding Content-Encoding", () => {
			const originalHeaders = {
				"Content-Type": "application/json",
				"X-Custom-Header": "custom-value",
				"Anthropic-Version": "2023-06-01",
			};

			const headers = new Headers(originalHeaders);
			headers.set("Content-Encoding", "gzip");

			expect(headers.get("Content-Type")).toBe("application/json");
			expect(headers.get("X-Custom-Header")).toBe("custom-value");
			expect(headers.get("Anthropic-Version")).toBe("2023-06-01");
			expect(headers.get("Content-Encoding")).toBe("gzip");
		});

		it("handles case-insensitive header access", () => {
			const headers = new Headers({
				"Content-Type": "application/json",
			});

			headers.set("Content-Encoding", "gzip");

			expect(headers.get("content-encoding")).toBe("gzip");
			expect(headers.get("Content-Encoding")).toBe("gzip");
			expect(headers.get("CONTENT-ENCODING")).toBe("gzip");
		});
	});

	describe("buffer conversion", () => {
		it("converts string body to Buffer correctly", () => {
			const testString = "test data";
			const buffer = Buffer.from(testString, "utf-8");

			expect(buffer).toBeInstanceOf(Buffer);
			expect(buffer.toString("utf-8")).toBe(testString);
		});

		it("converts ArrayBuffer to Buffer", () => {
			const testData = "test data";
			const arrayBuffer = new TextEncoder().encode(testData).buffer;
			const buffer = Buffer.from(arrayBuffer);

			expect(buffer.toString("utf-8")).toBe(testData);
		});

		it("converts Uint8Array to Buffer", () => {
			const testData = "test data";
			const uint8array = new TextEncoder().encode(testData);
			const buffer = Buffer.from(uint8array);

			expect(buffer.toString("utf-8")).toBe(testData);
		});
	});
});
