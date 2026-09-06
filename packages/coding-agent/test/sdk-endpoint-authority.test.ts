import { describe, expect, test } from "bun:test";
import { matchesIndexedEndpointFile } from "../src/sdk/broker/endpoint-authority";

describe("SDK endpoint index authority", () => {
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
