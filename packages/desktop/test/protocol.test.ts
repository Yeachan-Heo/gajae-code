import { describe, expect, test } from "bun:test";
import { type DesktopRequest, MAX_FRAME_BYTES, parseRequest } from "../../desktop-host/src/protocol";

describe("desktop request boundary", () => {
	test("preserves correlated cancellation and Unicode paths", () => {
		const request: DesktopRequest = {
			id: "abort-2",
			method: "abort",
			params: { sessionId: "세션", path: "/tmp/작업 공간" },
		};
		expect(parseRequest(JSON.stringify(request))).toEqual(request);
	});
	test.each([
		"null",
		"[]",
		"{}",
		'{"id":1,"method":"bootstrap","params":{}}',
		'{"id":"x","method":"bootstrap","params":[]}',
	])("rejects malformed envelope %s", line => {
		expect(() => parseRequest(line)).toThrow("Invalid request");
	});
	test("rejects byte-heavy oversized frames before parsing", () => {
		expect(() => parseRequest("한".repeat(Math.ceil(MAX_FRAME_BYTES / 3) + 1))).toThrow("frame limit");
	});
	test("rejects unknown operations and empty identifiers", () => {
		for (const request of [
			{ id: "x", method: "shell.execute", params: {} },
			{ id: "", method: "bootstrap", params: {} },
		]) {
			expect(() => parseRequest(JSON.stringify(request))).toThrow("Invalid request");
		}
	});
	test("rejects overlong correlation identifiers", () => {
		expect(() => parseRequest(JSON.stringify({ id: "x".repeat(129), method: "bootstrap", params: {} }))).toThrow(
			"Invalid request",
		);
	});
});
