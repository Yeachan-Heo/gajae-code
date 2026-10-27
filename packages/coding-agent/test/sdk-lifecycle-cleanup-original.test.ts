import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isCanonicalLifecycleCleanupOriginal } from "../src/sdk/broker/lifecycle";

describe("isCanonicalLifecycleCleanupOriginal", () => {
	const root = path.resolve("/tmp/gjc-lifecycle-cleanup-root");
	const dir = path.join(root, "sdk");
	const id = "session-1";
	const accepts = (name: string) => isCanonicalLifecycleCleanupOriginal(root, id, path.join(dir, name));

	it("accepts the canonical lifecycle file names", () => {
		expect(accepts("session-1.json")).toBe(true);
		expect(accepts("session-1.lifecycle.json")).toBe(true);
		expect(accepts("session-1.lifecycle.ready.json")).toBe(true);
		expect(accepts("session-1.lifecycle.failure.abc-123.json")).toBe(true);
		expect(accepts("session-1.lifecycle.failure.abc-123.json.promoting")).toBe(true);
	});

	it("requires literal dot separators in failure receipt names", () => {
		expect(accepts("session-1Xlifecycle.failure.abc.json")).toBe(false);
		expect(accepts("session-1.lifecycleXfailure.abc.json")).toBe(false);
		expect(accepts("session-1.lifecycle.failureXabc.json")).toBe(false);
		expect(accepts("session-1.lifecycle.failure.abcXjson")).toBe(false);
		expect(accepts("session-1.lifecycle.failure.abc.jsonXpromoting")).toBe(false);
	});

	it("rejects files outside the session sdk directory", () => {
		expect(isCanonicalLifecycleCleanupOriginal(root, id, path.join(root, "session-1.json"))).toBe(false);
	});
});
