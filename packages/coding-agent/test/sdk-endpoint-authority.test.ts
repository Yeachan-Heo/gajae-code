import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { endpointIncarnation, matchesIndexedEndpointFile } from "../src/sdk/broker/endpoint-authority";

describe("SDK endpoint index authority", () => {
	test("preserves the established identityful digest field order", () => {
		const record = { endpointGeneration: 3, endpointMtimeMs: 1_000.4, endpointFileId: "7:11", pid: 42 };
		const expected = createHash("sha256")
			.update(
				JSON.stringify({
					endpointGeneration: 3,
					endpointMtimeMs: 1_000,
					endpointFileId: "7:11",
					pid: 42,
					sessionId: "session",
				}),
			)
			.digest("hex");
		expect(endpointIncarnation(record, "session")).toBe(expected);
	});
	test("accepts the index timestamp precision used by broker endpoint reads", () => {
		const file = { dev: 7n, ino: 11n, mtimeMs: 1_000.123_456 };

		expect(
			matchesIndexedEndpointFile(file, {
				endpointMtimeMs: 1_000.123,
				endpointFileId: "7:11",
			}),
		).toBe(true);
	});

	test("rejects a changed endpoint file identity or material timestamp drift", () => {
		const file = { dev: 7n, ino: 11n, mtimeMs: 1_000.123_456 };

		expect(matchesIndexedEndpointFile(file, { endpointMtimeMs: file.mtimeMs, endpointFileId: "7:12" })).toBe(false);
		expect(matchesIndexedEndpointFile(file, { endpointMtimeMs: file.mtimeMs + 0.002, endpointFileId: "7:11" })).toBe(
			false,
		);
	});

	test("requires exact timestamp authority when the index has no file identity", () => {
		const file = { dev: 7n, ino: 11n, mtimeMs: 1_000.123_456 };

		expect(matchesIndexedEndpointFile(file, { endpointMtimeMs: file.mtimeMs })).toBe(true);
		expect(matchesIndexedEndpointFile(file, { endpointMtimeMs: file.mtimeMs + 0.0005 })).toBe(false);
	});
});
